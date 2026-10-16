import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { secureHeaders } from "hono/secure-headers";
import { safeEqual } from "../crypto/secrets";
import { createLogger } from "../log";
import type { AppDeps } from "../deps";
import { audit } from "../repos/audit";
import { getUserByExternalId, upsertUser } from "../repos/users";
import type { AppEnv } from "./env";
import { problem } from "./errors";

/** Best-effort client IP: Caddy's X-Forwarded-For first, then the socket. */
export function clientIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? null;
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

export function requestLog(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const log = createLogger("http");
  return async (c, next) => {
    const started = performance.now();
    const requestId = c.req.header("x-request-id") ?? crypto.randomUUID();
    c.set("requestId", requestId);
    await next();
    c.header("x-request-id", requestId);
    const ms = Math.round(performance.now() - started);
    const path = c.req.path;
    if (path === "/healthz" || path === "/readyz" || path.startsWith("/assets/") || path.includes("/audio/")) return;
    log.info(`${c.req.method} ${path} ${c.res.status} ${ms}ms`, { requestId });
  };
}

const API_CSP = {
  defaultSrc: ["'none'"],
  frameAncestors: ["'none'"],
};

/** Strict CSP for the dashboard (ADR-0016); the stage page gets its own relaxed copy. */
export function securityHeaders(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const wsOrigin = deps.config.publicOrigin.replace(/^http/, "ws");
  const extraScript = deps.config.AUTH_MODE === "clerk" ? ["https://*.clerk.accounts.dev", "https://challenges.cloudflare.com"] : [];
  const extraConnect = deps.config.AUTH_MODE === "clerk" ? ["https://*.clerk.accounts.dev", "https://api.clerk.com"] : [];
  const extraFrame = deps.config.AUTH_MODE === "clerk" ? ["https://challenges.cloudflare.com"] : [];
  const dashboard = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", ...extraScript],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:", "https:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", wsOrigin, ...extraConnect],
      frameSrc: extraFrame.length ? extraFrame : ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      objectSrc: ["'none'"],
    },
    referrerPolicy: "strict-origin-when-cross-origin",
    crossOriginEmbedderPolicy: false,
  });
  const stage = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      connectSrc: ["'self'", wsOrigin],
      objectSrc: ["'none'"],
    },
    xFrameOptions: false,
    crossOriginEmbedderPolicy: false,
  });
  const api = secureHeaders({ contentSecurityPolicy: API_CSP, crossOriginEmbedderPolicy: false });
  return (c, next) => {
    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/ws/")) return api(c, next);
    if (path.startsWith("/s/") || path === "/stage.html") return stage(c, next);
    return dashboard(c, next);
  };
}

/**
 * CSRF (ADR-0016): state-changing requests from a browser must come from our
 * own origin. Webhooks are exempt; they're verified by signature instead.
 */
export function csrfGuard(deps: AppDeps): MiddlewareHandler<AppEnv> {
  const allowed = new Set([deps.config.publicOrigin]);
  // In development, localhost and 127.0.0.1 are the same machine.
  if (!deps.config.isProduction) {
    allowed.add(deps.config.publicOrigin.replace("//localhost", "//127.0.0.1"));
    allowed.add(deps.config.publicOrigin.replace("//127.0.0.1", "//localhost"));
  }
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    if (c.req.path === "/api/billing/webhook") return next();
    const origin = c.req.header("origin");
    if (origin && !allowed.has(origin)) return problem(c, 403, "bad_origin", "This request came from another site and was blocked.");
    if (!origin && c.req.header("sec-fetch-site") === "cross-site") return problem(c, 403, "bad_origin", "This request came from another site and was blocked.");
    return next();
  };
}

const GATE_EXEMPT = [/^\/s\//, /^\/api\/stage\//, /^\/ws\/stage\//, /^\/api\/billing\/webhook$/, /^\/healthz$/, /^\/readyz$/, /^\/assets\//, /^\/fonts\//];

/**
 * ADR-0018 staging gate: with no sign-in (AUTH_MODE=dev) on a public server,
 * everything except stage links, webhooks and health checks needs the gate
 * password (HTTP Basic auth; any username).
 */
export function devGate(password: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const path = c.req.path;
    if (GATE_EXEMPT.some((pattern) => pattern.test(path))) return next();
    const header = c.req.header("authorization") ?? "";
    if (header.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
      const supplied = decoded.slice(decoded.indexOf(":") + 1);
      if (safeEqual(supplied, password)) return next();
    }
    c.header("www-authenticate", 'Basic realm="Lantern staging", charset="UTF-8"');
    return c.text("This server is private.", 401);
  };
}

/** Resolves the caller and provisions our user record just in time (ADR-0018). */
export function requireUser(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const identity = await deps.identity.resolve(c.req.raw);
    if (!identity) return problem(c, 401, "unauthenticated", "Sign in to continue.");
    let user = await getUserByExternalId(deps.db, identity.externalId);
    if (!user || (identity.email && identity.email !== user.email) || (identity.name && identity.name !== user.name)) {
      const existed = Boolean(user);
      user = await upsertUser(deps.db, identity);
      if (!existed) await audit(deps.db, { userId: user.id, action: "user.provisioned", ip: clientIp(c) });
    }
    c.set("user", user);
    return next();
  };
}

/**
 * Fixed-window rate limit in memory (ADR-0003). One process serves the app,
 * so a shared store isn't needed yet.
 */
export function rateLimit(options: { windowMs: number; max: number; key: (c: Context<AppEnv>) => string }): MiddlewareHandler<AppEnv> {
  const hits = new Map<string, { count: number; resetAt: number }>();
  let sweepAt = Date.now() + options.windowMs;
  return async (c, next) => {
    const now = Date.now();
    if (now > sweepAt) {
      for (const [key, entry] of hits) if (entry.resetAt < now) hits.delete(key);
      sweepAt = now + options.windowMs;
    }
    const key = options.key(c);
    let entry = hits.get(key);
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > options.max) {
      c.header("retry-after", String(Math.ceil((entry.resetAt - now) / 1000)));
      return problem(c, 429, "rate_limited", "Too many requests. Slow down for a moment.");
    }
    return next();
  };
}

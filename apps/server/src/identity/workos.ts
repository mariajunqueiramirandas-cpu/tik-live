import { WorkOS } from "@workos-inc/node";
import { Hono } from "hono";
import type { AppConfig } from "../config";
import { randomToken } from "../crypto/secrets";
import type { AppEnv } from "../http/env";
import { problem } from "../http/errors";
import type { Logger } from "../log";
import { readCookie } from "./dev";
import { sessionCookie, type Identity, type IdentityProvider } from "./types";

export const WORKOS_SESSION_COOKIE = "wos-session";
const STATE_COOKIE = "wos-state";
const SESSION_MAX_AGE = 400 * 24 * 3600; // browsers cap cookie lifetime at 400 days

interface WorkOSUser {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name?: string | null;
}

/** The slice of the WorkOS SDK this adapter uses (a fake in tests). */
export interface WorkOSLike {
  userManagement: {
    getAuthorizationUrl(options: { provider: string; clientId: string; redirectUri: string; state: string; screenHint?: "sign-up" | "sign-in" }): string;
    authenticateWithCode(options: { clientId: string; code: string; session: { sealSession: true; cookiePassword: string } }): Promise<{ user: WorkOSUser; sealedSession?: string }>;
    loadSealedSession(options: { sessionData: string; cookiePassword: string }): {
      authenticate(): Promise<{ authenticated: true; user: WorkOSUser } | { authenticated: false; reason: string }>;
      refresh(options: { cookiePassword: string }): Promise<{ authenticated: true; user: WorkOSUser; sealedSession?: string } | { authenticated: false; reason: string }>;
      getLogoutUrl(options?: { returnTo?: string }): Promise<string>;
    };
  };
}

function nameOf(user: WorkOSUser): string | null {
  return user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
}

/** Only same-site dashboard paths can be returned to after sign-in. */
function safeReturn(path: string | null | undefined): string {
  return path && /^\/app(\/[\w\-/?=&.%]*)?$/.test(path) && !path.startsWith("//") ? path : "/app";
}

/**
 * WorkOS AuthKit sign-in (ADR-0018): hosted sign-in pages, a sealed session
 * cookie verified on every request (and WebSocket upgrade), refreshed
 * transparently when its access token expires.
 */
export class WorkOSIdentityProvider implements IdentityProvider {
  readonly mode = "workos" as const;
  readonly signInPath = "/auth/sign-in";
  private readonly workos: WorkOSLike;

  constructor(
    private readonly config: AppConfig,
    options: { client?: WorkOSLike; log?: Logger } = {},
  ) {
    this.workos = options.client ?? (new WorkOS(config.WORKOS_API_KEY!, { clientId: config.WORKOS_CLIENT_ID! }) as unknown as WorkOSLike);
    this.log = options.log;
  }

  private readonly log: Logger | undefined;

  private cookie(value: string, maxAge = SESSION_MAX_AGE): string {
    return sessionCookie(WORKOS_SESSION_COOKIE, value, { secure: this.config.isProduction, maxAgeSeconds: maxAge });
  }

  async resolve(request: Request): Promise<Identity | null> {
    const sessionData = readCookie(request.headers.get("cookie"), WORKOS_SESSION_COOKIE);
    if (!sessionData) return null;
    const cookiePassword = this.config.WORKOS_COOKIE_PASSWORD!;
    try {
      const session = this.workos.userManagement.loadSealedSession({ sessionData, cookiePassword });
      const auth = await session.authenticate();
      if (auth.authenticated) return { externalId: `workos|${auth.user.id}`, email: auth.user.email, name: nameOf(auth.user) };
      // An expired access token is normal: refresh and hand back a new cookie.
      const refreshed = await session.refresh({ cookiePassword });
      if (!refreshed.authenticated) return null;
      return {
        externalId: `workos|${refreshed.user.id}`,
        email: refreshed.user.email,
        name: nameOf(refreshed.user),
        ...(refreshed.sealedSession ? { setCookies: [this.cookie(refreshed.sealedSession)] } : {}),
      };
    } catch (err) {
      this.log?.warn("workos session check failed", { error: String(err) });
      return null;
    }
  }

  routes(): Hono<AppEnv> {
    const origin = this.config.publicOrigin;
    const clientId = this.config.WORKOS_CLIENT_ID!;
    const cookiePassword = this.config.WORKOS_COOKIE_PASSWORD!;
    const secure = this.config.isProduction;
    return new Hono<AppEnv>()
      .get("/auth/sign-in", (c) => {
        const nonce = randomToken(16);
        const state = Buffer.from(JSON.stringify({ n: nonce, r: safeReturn(c.req.query("returnTo")) })).toString("base64url");
        const url = this.workos.userManagement.getAuthorizationUrl({
          provider: "authkit",
          clientId,
          redirectUri: `${origin}/auth/callback`,
          state,
          ...(c.req.query("signUp") ? { screenHint: "sign-up" as const } : {}),
        });
        c.header("set-cookie", sessionCookie(STATE_COOKIE, nonce, { secure, maxAgeSeconds: 600, path: "/auth" }));
        return c.redirect(url, 302);
      })
      .get("/auth/callback", async (c) => {
        const code = c.req.query("code");
        let state: { n?: string; r?: string } = {};
        try {
          state = JSON.parse(Buffer.from(c.req.query("state") ?? "", "base64url").toString("utf8")) as typeof state;
        } catch {
          // handled below
        }
        const expected = readCookie(c.req.header("cookie") ?? null, STATE_COOKIE);
        if (!code || !state.n || !expected || state.n !== expected) {
          return problem(c, 400, "bad_state", "Este link de entrada expirou. Comece de novo pela página de entrada.");
        }
        try {
          const result = await this.workos.userManagement.authenticateWithCode({ clientId, code, session: { sealSession: true, cookiePassword } });
          if (!result.sealedSession) throw new Error("no session returned");
          c.header("set-cookie", this.cookie(result.sealedSession), { append: true });
          c.header("set-cookie", sessionCookie(STATE_COOKIE, "", { secure, maxAgeSeconds: 0, path: "/auth" }), { append: true });
          return c.redirect(safeReturn(state.r), 302);
        } catch (err) {
          this.log?.warn("workos sign-in failed", { error: String(err) });
          return problem(c, 401, "sign_in_failed", "A entrada não foi concluída. Tente de novo.");
        }
      })
      .get("/auth/sign-out", async (c) => {
        const sessionData = readCookie(c.req.header("cookie") ?? null, WORKOS_SESSION_COOKIE);
        let target = `${origin}/`;
        if (sessionData) {
          try {
            target = await this.workos.userManagement.loadSealedSession({ sessionData, cookiePassword }).getLogoutUrl({ returnTo: `${origin}/` });
          } catch {
            // Clear our cookie regardless.
          }
        }
        c.header("set-cookie", this.cookie("", 0));
        return c.redirect(target, 302);
      });
  }
}

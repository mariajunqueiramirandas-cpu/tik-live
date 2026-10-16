import type { Hono } from "hono";
import type { AppEnv } from "../http/env";

/** Who is making a request, as the identity provider sees them (ADR-0018). */
export interface Identity {
  externalId: string;
  email?: string | null;
  name?: string | null;
  /** Cookies to set on the response (e.g. a refreshed session). */
  setCookies?: string[];
}

export interface IdentityProvider {
  readonly mode: "dev" | "clerk" | "workos";
  /** Returns the caller's identity, or null when unauthenticated. */
  resolve(request: Request): Promise<Identity | null>;
  /** Where the dashboard sends people who aren't signed in. */
  readonly signInPath: string | null;
  /** Routes the provider owns (sign-in callbacks, webhooks), mounted at the root. */
  routes?(): Hono<AppEnv>;
}

/** A Set-Cookie value with safe defaults for session cookies. */
export function sessionCookie(name: string, value: string, options: { secure: boolean; maxAgeSeconds: number; path?: string }): string {
  const parts = [`${name}=${value}`, `Path=${options.path ?? "/"}`, "HttpOnly", "SameSite=Lax", `Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

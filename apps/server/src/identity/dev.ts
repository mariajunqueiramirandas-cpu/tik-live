import type { Identity, IdentityProvider } from "./types";

export const DEV_USER_COOKIE = "tl_dev_user";
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Reads a cookie value from a Cookie header without pulling in a parser. */
export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

/**
 * Development identity (ADR-0018): no sign-in. Every request is the dev user
 * "local", unless impersonation picks another dev user via the
 * `x-dev-user` header, a `devUser` query parameter, or the dashboard's
 * dev-user cookie. Impersonation exists only in this provider.
 */
export class DevIdentityProvider implements IdentityProvider {
  readonly mode = "dev" as const;
  readonly signInPath = null;

  async resolve(request: Request): Promise<Identity> {
    const url = new URL(request.url);
    const requested =
      request.headers.get("x-dev-user") ?? url.searchParams.get("devUser") ?? readCookie(request.headers.get("cookie"), DEV_USER_COOKIE);
    const name = requested && NAME.test(requested.toLowerCase()) ? requested.toLowerCase() : "local";
    return {
      externalId: `dev|${name}`,
      email: `${name}@localhost`,
      name: name === "local" ? "Desenvolvedor" : name,
    };
  }
}

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ChannelDto } from "@tik-live/shared";
import { testConfig } from "../../src/config";
import { ClerkIdentityProvider, clerkFrontendApi, type ClerkLike } from "../../src/identity/clerk";
import { WORKOS_SESSION_COOKIE, WorkOSIdentityProvider, type WorkOSLike } from "../../src/identity/workos";
import { startTestServer, type TestServer } from "../harness";

const COOKIE_PASSWORD = "c".repeat(40);

/** A WorkOS stand-in: sealed sessions are "sealed:<userId>:<fresh|stale>". */
function fakeWorkOS(): WorkOSLike & { lastAuthUrl: string | null } {
  const user = (id: string) => ({ id, email: `${id}@example.com`, firstName: "Ana", lastName: "Silva" });
  const fake = {
    lastAuthUrl: null as string | null,
    userManagement: {
      getAuthorizationUrl(options: { redirectUri: string; state: string }) {
        fake.lastAuthUrl = `https://auth.example.com/authorize?redirect_uri=${encodeURIComponent(options.redirectUri)}&state=${options.state}`;
        return fake.lastAuthUrl;
      },
      async authenticateWithCode(options: { code: string; session: { cookiePassword: string } }) {
        if (options.code !== "good-code") throw new Error("invalid code");
        expect(options.session.cookiePassword).toBe(COOKIE_PASSWORD);
        return { user: user("user_1"), sealedSession: "sealed:user_1:fresh" };
      },
      loadSealedSession({ sessionData }: { sessionData: string }) {
        const [, id, freshness] = sessionData.split(":");
        return {
          async authenticate() {
            if (!sessionData.startsWith("sealed:")) return { authenticated: false as const, reason: "invalid_session_cookie" };
            return freshness === "fresh" ? { authenticated: true as const, user: user(id!) } : { authenticated: false as const, reason: "invalid_jwt" };
          },
          async refresh() {
            return id ? { authenticated: true as const, user: user(id), sealedSession: `sealed:${id}:fresh` } : { authenticated: false as const, reason: "invalid_session_cookie" };
          },
          async getLogoutUrl() {
            return "https://auth.example.com/logout";
          },
        };
      },
    },
  };
  return fake;
}

describe("WorkOS sign-in", () => {
  let server: TestServer;
  const workos = fakeWorkOS();

  beforeAll(async () => {
    const env = { AUTH_MODE: "workos", WORKOS_API_KEY: "sk_test", WORKOS_CLIENT_ID: "client_1", WORKOS_COOKIE_PASSWORD: COOKIE_PASSWORD };
    const config = testConfig({ PUBLIC_URL: "http://localhost:9999", ...env });
    server = await startTestServer({ env, identity: new WorkOSIdentityProvider(config, { client: workos }) });
  });
  afterAll(async () => {
    await server.close();
  });

  it("refuses the API without a session and points the dashboard at sign-in", async () => {
    expect((await server.api("/api/me")).status).toBe(401);
    const config = await server.json("/api/config");
    expect(config.body.signInPath).toBe("/auth/sign-in");
  });

  it("signs in through AuthKit with a state check, then uses the sealed session", async () => {
    const start = await server.api("/auth/sign-in?returnTo=/app/billing", { redirect: "manual" });
    expect(start.status).toBe(302);
    const location = start.headers.get("location")!;
    expect(location).toContain(encodeURIComponent("http://localhost:9999/auth/callback"));
    const state = new URL(location).searchParams.get("state")!;
    const stateCookie = start.headers.get("set-cookie")!.split(";")[0]!;

    // A callback without the matching state cookie is refused (login CSRF).
    expect((await server.api(`/auth/callback?code=good-code&state=${state}`, { redirect: "manual" })).status).toBe(400);

    const callback = await server.api(`/auth/callback?code=good-code&state=${state}`, { redirect: "manual", headers: { cookie: stateCookie } });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/app/billing");
    const session = callback.headers.getSetCookie().find((c) => c.startsWith(`${WORKOS_SESSION_COOKIE}=`))!;
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");

    const me = await server.json("/api/me", { headers: { cookie: session.split(";")[0]! } });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("user_1@example.com");
    expect(me.body.user.name).toBe("Ana Silva");
    expect(me.body.devUser).toBeNull();
  });

  it("refreshes an expired session transparently", async () => {
    const res = await server.api("/api/me", { headers: { cookie: `${WORKOS_SESSION_COOKIE}=sealed:user_1:stale` } });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie().some((c) => c.startsWith(`${WORKOS_SESSION_COOKIE}=sealed:user_1:fresh`))).toBe(true);
  });

  it("never redirects off-site after sign-in, and signs out", async () => {
    const start = await server.api("/auth/sign-in?returnTo=//evil.example/x", { redirect: "manual" });
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const callback = await server.api(`/auth/callback?code=good-code&state=${state}`, { redirect: "manual", headers: { cookie: start.headers.get("set-cookie")!.split(";")[0]! } });
    expect(callback.headers.get("location")).toBe("/app");

    const out = await server.api("/auth/sign-out", { redirect: "manual", headers: { cookie: `${WORKOS_SESSION_COOKIE}=sealed:user_1:fresh` } });
    expect(out.headers.get("location")).toBe("https://auth.example.com/logout");
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("keeps tenants apart and ignores dev impersonation", async () => {
    const mine = { cookie: `${WORKOS_SESSION_COOKIE}=sealed:user_1:fresh` };
    const theirs = { cookie: `${WORKOS_SESSION_COOKIE}=sealed:user_2:fresh` };
    const created = await server.json<{ channel: ChannelDto }>("/api/channels", { method: "POST", headers: mine, json: { name: "Mine" } });
    expect(created.status).toBe(201);
    expect((await server.json(`/api/channels/${created.body.channel.id}`, { headers: theirs })).status).toBe(404);
    expect((await server.api("/api/me", { headers: { "x-dev-user": "user_1" } })).status).toBe(401);
  });
});

describe("Clerk sign-in", () => {
  it("resolves the Clerk user, caches the profile, and verifies the caller's origin", async () => {
    const calls = { auth: [] as Array<string[] | undefined>, profiles: 0 };
    const client: ClerkLike = {
      async authenticateRequest(request, options) {
        calls.auth.push(options.authorizedParties);
        const signedIn = request.headers.get("cookie")?.includes("__session=ok");
        return { isAuthenticated: Boolean(signedIn), toAuth: () => (signedIn ? { userId: "user_9" } : null) };
      },
      users: {
        async getUser(id) {
          calls.profiles += 1;
          return { id, firstName: "Bia", lastName: null, username: "bia", primaryEmailAddress: { emailAddress: "bia@example.com" } };
        },
      },
    };
    const config = testConfig({ PUBLIC_URL: "https://lantern.example", AUTH_MODE: "clerk", CLERK_SECRET_KEY: "sk_test_x", CLERK_PUBLISHABLE_KEY: "pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ" });
    const provider = new ClerkIdentityProvider(config, { client });
    const request = () => new Request("https://lantern.example/api/me", { headers: { cookie: "__session=ok" } });

    expect(await provider.resolve(new Request("https://lantern.example/api/me"))).toBeNull();
    expect(await provider.resolve(request())).toEqual({ externalId: "clerk|user_9", email: "bia@example.com", name: "Bia" });
    await provider.resolve(request());
    expect(calls.profiles).toBe(1);
    expect(calls.auth[0]).toEqual(["https://lantern.example"]);
    expect(provider.signInPath).toBe("/app/sign-in");
  });

  it("reads the frontend API host from the publishable key", () => {
    expect(clerkFrontendApi("pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ")).toBe("https://foo.clerk.accounts.dev");
    expect(clerkFrontendApi("pk_live_Y2xlcmsubGFudGVybi5leGFtcGxlJA")).toBe("https://clerk.lantern.example");
    expect(clerkFrontendApi("nonsense")).toBeNull();
  });
});

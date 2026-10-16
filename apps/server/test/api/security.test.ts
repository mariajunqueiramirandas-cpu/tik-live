import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../../src/config";
import { Secrets, randomToken, safeEqual } from "../../src/crypto/secrets";
import { startTestServer, stageKeyFrom, type TestServer } from "../harness";

describe("configuration guards", () => {
  const base = { DATABASE_URL: "pglite://memory" };

  it("refuses an insecure production setup", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", APP_SECRET: "x".repeat(40) })).toThrow(/DEV_GATE_PASSWORD/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", APP_SECRET: "x".repeat(40), DEV_GATE_PASSWORD: "staging-pass" })).not.toThrow();
  });

  it("requires complete provider settings", () => {
    expect(() => loadConfig({ ...base, MP_ACCESS_TOKEN: "x" })).toThrow(/MP_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, AUTH_MODE: "clerk" })).toThrow(/CLERK_SECRET_KEY/);
    expect(() => loadConfig({ ...base, BROADCAST_ENABLED: "true" })).toThrow(/BROADCASTER_URL/);
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ ...base, ANTHROPIC_API_KEY: "  ", MP_ACCESS_TOKEN: "", MP_WEBHOOK_SECRET: "" });
    expect(config.aiEnabled).toBe(false);
    expect(config.billingEnabled).toBe(false);
  });
});

describe("secrets at rest", () => {
  const secrets = new Secrets("s".repeat(48));

  it("round-trips, separates purposes, and detects tampering", async () => {
    const sealed = await secrets.encrypt("stream-key", "live_abc");
    expect(sealed).toMatch(/^v1\./);
    expect(await secrets.decrypt("stream-key", sealed)).toBe("live_abc");
    await expect(secrets.decrypt("stage-key", sealed)).rejects.toThrow();
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);
    await expect(secrets.decrypt("stream-key", tampered)).rejects.toThrow();
    expect(await secrets.encrypt("stream-key", "live_abc")).not.toBe(sealed);
  });

  it("derives stable lookups that depend on the app secret", async () => {
    const other = new Secrets("o".repeat(48));
    expect(await secrets.lookup("key")).toBe(await secrets.lookup("key"));
    expect(await secrets.lookup("key")).not.toBe(await other.lookup("key"));
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("staging gate (ADR-0018)", () => {
  let server: TestServer;
  beforeAll(async () => {
    server = await startTestServer({ env: { DEV_GATE_PASSWORD: "let-me-in-please" } });
  });
  afterAll(async () => {
    await server.close();
  });

  it("requires the gate password for the dashboard and API, but not for stage links or health", async () => {
    const denied = await server.api("/api/config");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Basic");
    const auth = { authorization: `Basic ${Buffer.from("anyone:let-me-in-please").toString("base64")}` };
    expect((await server.api("/api/config", { headers: auth })).status).toBe(200);
    expect((await server.api("/api/config", { headers: { authorization: `Basic ${Buffer.from("x:wrong").toString("base64")}` } })).status).toBe(401);
    expect((await server.api("/healthz")).status).toBe(200);

    const created = await server.json("/api/channels", { method: "POST", json: { name: "gated" }, headers: auth });
    const key = stageKeyFrom(created.body.channel.stageUrl);
    const stage = await server.socket(`/ws/stage/${key}`);
    expect((await stage.next((m) => m.t === "hello")).t).toBe("hello");
    stage.close();
  });
});

describe("static files", () => {
  let server: TestServer;
  let dist: string;
  beforeAll(async () => {
    dist = mkdtempSync(path.join(tmpdir(), "lantern-dist-"));
    mkdirSync(path.join(dist, "assets"));
    writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>app</title>");
    writeFileSync(path.join(dist, "landing.html"), "<!doctype html><title>landing</title>");
    writeFileSync(path.join(dist, "stage.html"), "<!doctype html><title>stage</title>");
    writeFileSync(path.join(dist, "assets", "app-abc123.js"), "console.log(1)");
    server = await startTestServer({ env: { WEB_DIST: dist } });
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("serves the landing page, SPA routes, immutable assets and the stage page", async () => {
    expect(await (await server.api("/")).text()).toContain("landing");
    const app = await server.api("/app/channels/123");
    expect(await app.text()).toContain("<title>app</title>");
    expect(app.headers.get("cache-control")).toBe("no-cache");
    expect(app.headers.get("content-security-policy")).toContain("script-src 'self'");
    const asset = await server.api("/assets/app-abc123.js");
    expect(asset.headers.get("cache-control")).toContain("immutable");
    expect((await server.api("/assets/missing.js")).status).toBe(404);

    const created = await server.json("/api/channels", { method: "POST", user: "viewer", json: { name: "x" } });
    const stage = await server.api(`/s/${stageKeyFrom(created.body.channel.stageUrl)}`);
    expect(await stage.text()).toContain("<title>stage</title>");
    expect(stage.headers.get("x-frame-options")).toBeNull();
    expect((await server.api("/s/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
  });

  it("never serves files outside the build directory", async () => {
    for (const probe of ["/../package.json", "/%2e%2e/package.json", "/assets/../../package.json"]) {
      const res = await server.api(probe);
      expect(await res.text()).not.toContain('"name"');
    }
  });
});

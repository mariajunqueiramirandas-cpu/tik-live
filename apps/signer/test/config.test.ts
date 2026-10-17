import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const TOKEN = "t".repeat(24);

describe("signer config", () => {
  test("needs a token of at least 24 characters", () => {
    expect(() => loadConfig({})).toThrow(/SIGNER_TOKEN/);
    expect(() => loadConfig({ SIGNER_TOKEN: "short" })).toThrow(/at least 24/);
  });

  test("defaults: loopback only, no proxy, the container as the boundary (Chromium's sandbox opt-in)", () => {
    const config = loadConfig({ SIGNER_TOKEN: TOKEN });
    expect(config).toMatchObject({ HOST: "127.0.0.1", PORT: 8091, SIGNER_SANDBOX: false, SIGNER_MAX_CONCURRENT: 4, isProduction: false });
    expect(config.SIGNER_PROXY_URL).toBeUndefined();
  });

  test("blank values count as unset", () => {
    const config = loadConfig({ SIGNER_TOKEN: TOKEN, SIGNER_PROXY_URL: "  ", CHROMIUM_PATH: "" });
    expect(config.SIGNER_PROXY_URL).toBeUndefined();
    expect(config.CHROMIUM_PATH).toBeUndefined();
  });

  test("talks to the webcast host the connector uses unless told otherwise", () => {
    expect(loadConfig({ SIGNER_TOKEN: TOKEN }).SIGNER_WEBCAST_ORIGIN).toBe("https://webcast.tiktok.com");
    expect(loadConfig({ SIGNER_TOKEN: TOKEN, SIGNER_WEBCAST_ORIGIN: "https://webcast.us.tiktok.com" }).SIGNER_WEBCAST_ORIGIN).toBe("https://webcast.us.tiktok.com");
  });

  test("Oxylabs needs both its user and password, and can't be combined with a proxy URL", () => {
    expect(() => loadConfig({ SIGNER_TOKEN: TOKEN, OXYLABS_USERNAME: "u" })).toThrow(/both OXYLABS_USERNAME and OXYLABS_PASSWORD/);
    expect(() => loadConfig({ SIGNER_TOKEN: TOKEN, OXYLABS_PASSWORD: "p" })).toThrow(/both OXYLABS_USERNAME and OXYLABS_PASSWORD/);
    expect(() => loadConfig({ SIGNER_TOKEN: TOKEN, OXYLABS_USERNAME: "u", OXYLABS_PASSWORD: "p", SIGNER_PROXY_URL: "http://proxy.example.com:8080" })).toThrow(/either SIGNER_PROXY_URL or the OXYLABS_/);
  });

  test("Oxylabs defaults: the standard entry node, a session a little longer than the recycle time, one retry", () => {
    const config = loadConfig({ SIGNER_TOKEN: TOKEN, OXYLABS_USERNAME: "u", OXYLABS_PASSWORD: "p" });
    expect(config).toMatchObject({ OXYLABS_ENDPOINT: "pr.oxylabs.io:7777", oxylabsSessionMinutes: 40, SIGNER_REFUSAL_RETRIES: 1 });
    expect(loadConfig({ SIGNER_TOKEN: TOKEN, SIGNER_RECYCLE_MINUTES: "1440", OXYLABS_USERNAME: "u", OXYLABS_PASSWORD: "p" }).oxylabsSessionMinutes).toBe(1_440);
    expect(loadConfig({ SIGNER_TOKEN: TOKEN, OXYLABS_USERNAME: "u", OXYLABS_PASSWORD: "p", OXYLABS_SESSION_MINUTES: "5" }).oxylabsSessionMinutes).toBe(5);
  });

  test("validates the Oxylabs country and entry node", () => {
    const ok = { SIGNER_TOKEN: TOKEN, OXYLABS_USERNAME: "u", OXYLABS_PASSWORD: "p" };
    expect(loadConfig({ ...ok, OXYLABS_COUNTRY: "br" }).OXYLABS_COUNTRY).toBe("br");
    expect(() => loadConfig({ ...ok, OXYLABS_COUNTRY: "BRA" })).toThrow(/OXYLABS_COUNTRY/);
    expect(() => loadConfig({ ...ok, OXYLABS_ENDPOINT: "https://pr.oxylabs.io" })).toThrow(/OXYLABS_ENDPOINT/);
    expect(loadConfig({ ...ok, OXYLABS_ENDPOINT: "br-pr.oxylabs.io:10000" }).OXYLABS_ENDPOINT).toBe("br-pr.oxylabs.io:10000");
  });

  test("rejects a proxy that isn't a URL", () => {
    expect(() => loadConfig({ SIGNER_TOKEN: TOKEN, SIGNER_PROXY_URL: "not a url" })).toThrow(/SIGNER_PROXY_URL/);
  });
});

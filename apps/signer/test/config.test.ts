import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const TOKEN = "t".repeat(24);

describe("signer config", () => {
  test("needs a token of at least 24 characters", () => {
    expect(() => loadConfig({})).toThrow(/SIGNER_TOKEN/);
    expect(() => loadConfig({ SIGNER_TOKEN: "short" })).toThrow(/at least 24/);
  });

  test("defaults are safe: loopback, sandbox on, no proxy", () => {
    const config = loadConfig({ SIGNER_TOKEN: TOKEN });
    expect(config).toMatchObject({ HOST: "127.0.0.1", PORT: 8091, SIGNER_NO_SANDBOX: false, SIGNER_MAX_CONCURRENT: 4, isProduction: false });
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

  test("rejects a proxy that isn't a URL", () => {
    expect(() => loadConfig({ SIGNER_TOKEN: TOKEN, SIGNER_PROXY_URL: "not a url" })).toThrow(/SIGNER_PROXY_URL/);
  });
});

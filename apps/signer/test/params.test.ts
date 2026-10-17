import { describe, expect, test } from "bun:test";
import { SignerError } from "../src/backend";
import { baselineFromIdentity, baselineFromOwnRequest, parseRoomLookup, roomLookupUrl, webcastFetchUrl } from "../src/params";
import { isSigned, parseProxy } from "../src/browser-backend";

const identity = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  language: "pt-BR",
  platform: "Win32",
  timezone: "America/Sao_Paulo",
  screenWidth: 1920,
  screenHeight: 1080,
};

describe("request parameters", () => {
  test("copies only identity parameters from a request TikTok's own page made, never its signature", () => {
    const own =
      "https://webcast.us.tiktok.com/webcast/feed/?aid=1988&device_id=7000000000000000001&region=BR&channel_id=86&count=20&X-Bogus=abc&X-Gnarly=def&msToken=ghi&X-Dynosaur=jkl";
    expect(baselineFromOwnRequest(own)).toEqual({ aid: "1988", device_id: "7000000000000000001", region: "BR" });
  });

  test("the fallback baseline describes the browser it runs in", () => {
    const baseline = baselineFromIdentity(identity);
    expect(baseline).toMatchObject({
      browser_language: "pt-BR",
      app_language: "pt",
      browser_platform: "Win32",
      os: "windows",
      tz_name: "America/Sao_Paulo",
      screen_width: "1920",
      screen_height: "1080",
      user_is_login: "false",
    });
    expect(baseline.browser_version).toBe(identity.userAgent.slice("Mozilla/".length));
  });

  test("the join request carries the room, the cursor and the protocol parameters", () => {
    const url = new URL(webcastFetchUrl("https://webcast.us.tiktok.com", { device_id: "7" }, { roomId: "7697628243302304518", cursor: "c1" }, 150));
    expect(url.origin + url.pathname).toBe("https://webcast.us.tiktok.com/webcast/im/fetch/");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      device_id: "7",
      room_id: "7697628243302304518",
      cursor: "c1",
      last_rtt: "150",
      resp_content_type: "protobuf",
      client_enter: "1",
      identity: "audience",
      live_id: "12",
    });
  });

  test("the protocol parameters win over anything the baseline carried", () => {
    const url = new URL(webcastFetchUrl("https://x.test", { room_id: "1", cursor: "old", identity: "anchor" }, { roomId: "2", cursor: "" }, 100));
    expect(url.searchParams.get("room_id")).toBe("2");
    expect(url.searchParams.get("cursor")).toBe("");
    expect(url.searchParams.get("identity")).toBe("audience");
  });

  test("room lookup URLs escape the handle", () => {
    expect(new URL(roomLookupUrl("https://www.tiktok.com", "a.b_c")).searchParams.get("uniqueId")).toBe("a.b_c");
  });
});

describe("room lookup parsing", () => {
  test("a live room", () => {
    expect(parseRoomLookup({ statusCode: 0, data: { user: { roomId: "7697628243302304518", status: 2 } } })).toEqual({
      found: true,
      roomId: "7697628243302304518",
      status: 2,
      isLive: true,
    });
  });

  test("a finished room is not live", () => {
    expect(parseRoomLookup({ data: { user: { roomId: "7675416746324511502", status: 4 } } })).toMatchObject({ found: true, isLive: false, status: 4 });
  });

  test("an account that never streamed has no room", () => {
    expect(parseRoomLookup({ data: { user: { roomId: "", status: 4 } } })).toEqual({ found: true, roomId: null, status: 4, isLive: false });
    expect(parseRoomLookup({ data: { user: { roomId: "0" } } })).toMatchObject({ roomId: null, isLive: false });
  });

  test("an unknown account is not found, not an error", () => {
    expect(parseRoomLookup({ statusCode: 19881007 })).toEqual({ found: false, roomId: null, status: null, isLive: false });
  });

  test("other TikTok errors and unexpected shapes are upstream errors", () => {
    expect(() => parseRoomLookup({ statusCode: 10201, message: "nope" })).toThrow(SignerError);
    expect(() => parseRoomLookup({ statusCode: 0 })).toThrow(/captcha/);
    expect(() => parseRoomLookup(null)).toThrow(SignerError);
  });
});

describe("browser backend helpers", () => {
  test("a request is signed when TikTok's script added X-Bogus", () => {
    expect(isSigned("https://x.test/webcast/im/fetch/?a=1&X-Bogus=abc")).toBe(true);
    expect(isSigned("https://x.test/webcast/im/fetch/?X-Bogus=abc&a=1")).toBe(true);
    expect(isSigned("https://x.test/webcast/im/fetch/?a=1&msToken=abc")).toBe(false);
    expect(isSigned("https://x.test/webcast/im/fetch/?a=1")).toBe(false);
  });

  test("proxy URLs split into server and credentials", () => {
    expect(parseProxy("http://user:p%40ss@proxy.example.com:8080")).toEqual({ server: "http://proxy.example.com:8080", username: "user", password: "p@ss" });
    expect(parseProxy("socks5://proxy.example.com:1080")).toEqual({ server: "socks5://proxy.example.com:1080" });
  });
});

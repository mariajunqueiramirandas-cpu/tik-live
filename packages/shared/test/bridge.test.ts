import { describe, expect, it } from "bun:test";
import { bridgeDeviceWsUrl, decodeBridgeStamp, encodeBridgeStamp, formatPairingCode, normalizePairingCode, toBridgeWsUrl } from "../src";

describe("bridge pairing codes", () => {
  it("accepts what people type and rejects lookalike characters", () => {
    expect(normalizePairingCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizePairingCode(" AbCd 2345 ")).toBe("ABCD2345");
    expect(normalizePairingCode("ABCD-234")).toBeNull();
    expect(normalizePairingCode("ABCD-O345")).toBeNull();
    expect(normalizePairingCode("ABCD-1345")).toBeNull();
    expect(formatPairingCode("ABCD2345")).toBe("ABCD-2345");
  });
});

describe("bridge executable stamp", () => {
  it("round-trips at the end of an arbitrary binary", () => {
    const exe = crypto.getRandomValues(new Uint8Array(10_000));
    const stamp = encodeBridgeStamp({ server: "https://lantern.example", code: "ABCD2345" });
    const file = new Uint8Array(exe.length + stamp.length);
    file.set(exe);
    file.set(stamp, exe.length);
    expect(decodeBridgeStamp(file.subarray(file.length - 4096))).toEqual({ server: "https://lantern.example", code: "ABCD2345" });
  });

  it("finds nothing in an unstamped or truncated file", () => {
    expect(decodeBridgeStamp(crypto.getRandomValues(new Uint8Array(4096)))).toBeNull();
    const stamp = encodeBridgeStamp({ server: "https://lantern.example", code: "ABCD2345" });
    expect(decodeBridgeStamp(stamp.subarray(10))).toBeNull();
    expect(decodeBridgeStamp(new Uint8Array(0))).toBeNull();
  });
});

describe("bridge URLs", () => {
  it("derives the paired endpoint from the app's address", () => {
    expect(bridgeDeviceWsUrl("https://lantern.example/app/hosts")).toBe("wss://lantern.example/ws/bridge");
    expect(bridgeDeviceWsUrl("http://localhost:5173")).toBe("ws://localhost:5173/ws/bridge");
    expect(() => bridgeDeviceWsUrl("ftp://x")).toThrow();
  });

  it("still converts legacy stage links", () => {
    expect(toBridgeWsUrl("https://lantern.example/s/abcdefghijklmnop")).toBe("wss://lantern.example/ws/bridge/abcdefghijklmnop");
  });
});

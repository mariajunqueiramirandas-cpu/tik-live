import { describe, expect, it } from "bun:test";
import {
  channelUpdateSchema,
  injectEventSchema,
  limitsToWire,
  parseMessage,
  personaSchema,
  PLANS,
  PRESETS,
  PROTOCOL_VERSION,
  stageClientMessageSchema,
  stageServerMessageSchema,
  studioClientMessageSchema,
  tiktokHandleSchema,
  speechWords,
} from "../src";

describe("protocol v2 contracts", () => {
  it("round-trips every server-to-stage message", () => {
    const look = { character: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" };
    const messages = [
      { v: 2, t: "hello", serverTime: 1, name: "Blip", look, disclosure: "Blip is an AI host" },
      { v: 2, t: "speak", id: "c1", text: "Hi!", emotion: "happy", audioUrl: null, durationMs: 1200 },
      { v: 2, t: "cue", id: "c2", text: "Hi there!", emotion: "happy", audioUrl: "/a/c2", durationMs: 1200, words: [0, 310] },
      { v: 2, t: "drop", ids: ["c2"] },
      { v: 2, t: "stop" },
      { v: 2, t: "alert", kind: "gift", name: "Maria", giftName: "Rose", count: 3, diamonds: 3 },
      { v: 2, t: "segment", title: "Hangout" },
      { v: 2, t: "stats", viewers: 5, likes: 10 },
      { v: 2, t: "look", name: "Blip", look },
      { v: 2, t: "hold" },
    ];
    for (const message of messages) {
      expect(parseMessage(stageServerMessageSchema, JSON.stringify(message))).toEqual(message as never);
    }
    expect(PROTOCOL_VERSION).toBe(2);
  });

  it("splits a line into the words captions and word timings use", () => {
    expect(speechWords("  Five roses   from Theo!\n")).toEqual(["Five", "roses", "from", "Theo!"]);
  });

  it("validates untrusted client messages without throwing", () => {
    expect(parseMessage(stageClientMessageSchema, '{"v":1,"t":"spoken","id":"c1"}')).toEqual({ v: 1, t: "spoken", id: "c1" });
    expect(parseMessage(stageClientMessageSchema, '{"v":1,"t":"telemetry","fps":59.9,"frameP95":4.1,"quality":0}')).toBeDefined();
    expect(parseMessage(stageClientMessageSchema, '{"v":1,"t":"telemetry","fps":-1,"frameP95":4,"quality":0}')).toBeUndefined();
    expect(parseMessage(stageClientMessageSchema, "not json")).toBeUndefined();
    expect(parseMessage(studioClientMessageSchema, { v: 1, t: "command", id: "a", command: { kind: "say", text: "  hi  " } })).toEqual({
      v: 1,
      t: "command",
      id: "a",
      command: { kind: "say", text: "hi" },
    });
    expect(parseMessage(studioClientMessageSchema, { v: 1, t: "command", id: "a", command: { kind: "rm -rf" } })).toBeUndefined();
  });

  it("fills test-event defaults", () => {
    expect(injectEventSchema.parse({ kind: "gift", handle: "maria" })).toEqual({ kind: "gift", handle: "maria", giftName: "Rose", count: 1, diamonds: 1 });
  });
});

describe("schemas", () => {
  it("normalizes handles and colors", () => {
    expect(tiktokHandleSchema.parse("@night.owl_")).toBe("night.owl_");
    expect(() => tiktokHandleSchema.parse("no spaces allowed")).toThrow();
    const persona = personaSchema.parse({ ...PRESETS[0]!.persona, look: { character: "orb", primary: "#00ff88", secondary: "#ff00aa", background: "#000000" } });
    expect(persona.look.primary).toBe("#00FF88");
    expect(() => channelUpdateSchema.parse({ persona: { ...PRESETS[0]!.persona, segments: [] } })).toThrow();
  });

  it("ships valid presets", () => {
    for (const preset of PRESETS) expect(() => personaSchema.parse(preset.persona)).not.toThrow();
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it("sends unlimited limits as null over JSON", () => {
    const wire = limitsToWire(PLANS["self-hosted"].limits);
    expect(wire.runningChannels).toBeNull();
    expect(JSON.parse(JSON.stringify(wire)).liveHoursPerMonth).toBeNull();
    expect(limitsToWire(PLANS.free.limits).liveHoursPerMonth).toBe(5);
  });
});

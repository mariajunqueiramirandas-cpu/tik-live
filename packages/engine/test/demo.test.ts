import { describe, expect, it } from "bun:test";
import { DEMO_SCRIPT, estimateLineMs, startDemo } from "../src/demo";
import { FakeEngine } from "./fakes";

describe("demo driver", () => {
  it("plays a script through the engine like a real show", async () => {
    const engine = new FakeEngine("demo");
    const beats: string[] = [];
    const demo = startDemo(engine, {
      loop: false,
      script: [
        { kind: "segment", title: "Hello" },
        { kind: "say", text: "Hi chat", emotion: "happy" },
        { kind: "follow", name: "ana" },
      ],
      onBeat: (beat) => beats.push(beat.kind),
    });
    await Bun.sleep(1600);
    expect(beats).toEqual(["segment", "say", "follow"]);
    expect(engine.applied.map((m) => m.t)).toEqual(["segment", "speak", "alert"]);
    const speak = engine.applied[1] as { audioUrl: string | null; durationMs: number };
    expect(speak.audioUrl).toBeNull();
    expect(speak.durationMs).toBe(estimateLineMs("Hi chat"));
    demo.stop();
    expect(engine.applied.at(-1)?.t).toBe("stop");
  });

  it("stops mid-script", async () => {
    const engine = new FakeEngine("demo");
    const demo = startDemo(engine, { script: [{ kind: "pause", ms: 50 }, { kind: "follow", name: "x" }] });
    demo.stop();
    await Bun.sleep(120);
    expect(engine.applied.filter((m) => m.t === "alert")).toHaveLength(0);
  });

  it("ships a default script with every kind of moment", () => {
    const kinds = new Set(DEMO_SCRIPT.map((b) => b.kind));
    for (const kind of ["say", "gift", "follow", "share", "segment"]) expect(kinds.has(kind as never)).toBe(true);
    for (const beat of DEMO_SCRIPT) if (beat.kind === "say") expect(beat.text.length).toBeLessThan(140);
  });
});

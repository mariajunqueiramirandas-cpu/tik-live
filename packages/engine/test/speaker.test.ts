import { describe, expect, it } from "bun:test";
import { AudioEngine } from "../src/audio/audio";
import { Emitter, Speaker, type Line } from "../src/engine";

const line = (id: string, durationMs = 30): Line => ({ id, text: `line ${id}`, emotion: "neutral", audioUrl: null, durationMs });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function setup(mode: "program" | "preview" = "program") {
  const events = new Emitter();
  const log: string[] = [];
  events.on("started", (id) => log.push(`started ${id}`));
  events.on("spoken", (id) => log.push(`spoken ${id}`));
  const speaker = new Speaker(new AudioEngine(), mode, events, {
    begin: (l) => log.push(`begin ${l.id}`),
    finished: (l) => log.push(`finished ${l.id}`),
  });
  return { speaker, log };
}

describe("Speaker", () => {
  it("lets a line finish before starting the next one", async () => {
    const { speaker, log } = setup();
    speaker.speak(line("a"));
    speaker.speak(line("b"));
    expect(speaker.queued).toBe(1);
    await wait(100);
    expect(log).toEqual(["begin a", "started a", "finished a", "spoken a", "begin b", "started b", "finished b", "spoken b"]);
  });

  it("stop() cuts the current line and drops the waiting ones", async () => {
    const { speaker, log } = setup();
    speaker.speak(line("a", 50));
    speaker.speak(line("b"));
    await wait(5);
    speaker.stop();
    await wait(100);
    expect(log).toEqual(["begin a", "started a"]);
    expect(speaker.current).toBeNull();
    expect(speaker.queued).toBe(0);
  });

  it("skips the stalest waiting line when it falls far behind", async () => {
    const { speaker, log } = setup();
    for (const id of ["a", "b", "c", "d", "e"]) speaker.speak(line(id, 10));
    expect(speaker.queued).toBe(3);
    expect(log).toContain("spoken b"); // released so the server isn't left waiting
    await wait(150);
    expect(log.filter((entry) => entry.startsWith("begin"))).toEqual(["begin a", "begin c", "begin d", "begin e"]);
  });

  it("previews play lines without reporting them", async () => {
    const { speaker, log } = setup("preview");
    speaker.speak(line("a"));
    await wait(60);
    expect(log).toEqual(["begin a", "finished a"]);
  });
});

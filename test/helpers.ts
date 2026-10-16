import type { Persona } from "../src/config.js";
import type { LiveEvent, Viewer } from "../src/events/types.js";

export const persona: Persona = {
  name: "Blip",
  tagline: "a test orb",
  description: "A test character.",
  style: "Short.",
  catchphrases: ["Blip blip!"],
  rules: [],
  maxSentences: 3,
  segments: [
    { id: "a", title: "Segment A", minutes: 5, prompt: "Do A." },
    { id: "b", title: "Segment B", minutes: 5, prompt: "Do B." },
  ],
  visual: { mode: "orb", primary: "#7CF5FF", secondary: "#FF5FD2", background: "#0B0420" },
};

export function viewer(handle: string, id = handle): Viewer {
  return { id, handle, nickname: handle };
}

export function chat(handle: string, text: string, at = 0): LiveEvent {
  return { kind: "chat", at, viewer: viewer(handle), text };
}

export function gift(handle: string, giftName: string, diamonds: number, at = 0): LiveEvent {
  return { kind: "gift", at, viewer: viewer(handle), giftName, count: 1, diamonds };
}

/** A manually advanced clock for deterministic timing tests. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

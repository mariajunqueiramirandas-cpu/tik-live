import { describe, expect, it } from "bun:test";
import {
  gameSceneSchema,
  MAX_TRACK_SECONDS,
  midiToHz,
  MUSIC_LIBRARY,
  musicTrackSchema,
  noteToMidi,
  parseMessage,
  parsePattern,
  passSeconds,
  stageServerMessageSchema,
  studioClientMessageSchema,
} from "../src";

describe("music language", () => {
  it("parses rests, holds, hits, notes and chords, ignoring bar lines", () => {
    expect(parsePattern("x . - C4 | Bb2 C4+E4+G4")).toEqual([
      { kind: "hit" },
      { kind: "rest" },
      { kind: "hold" },
      { kind: "notes", midi: [60] },
      { kind: "notes", midi: [46] },
      { kind: "notes", midi: [60, 64, 67] },
    ]);
    expect(noteToMidi("A4")).toBe(69);
    expect(noteToMidi("C#4")).toBe(61);
    expect(midiToHz(69)).toBe(440);
  });

  it("rejects anything that isn't the step language", () => {
    expect(parsePattern("boom boom")).toBeNull();
    expect(parsePattern("H4")).toBeNull();
    expect(parsePattern("C4+E4+G4+B4+D5")).toBeNull(); // chords of four at most
    expect(parsePattern(Array(129).fill("x").join(" "))).toBeNull(); // eight bars at most
    expect(parsePattern("")).toBeNull();
  });

  it("clamps repeats so a piece never runs past the limit", () => {
    const track = musicTrackSchema.parse({ title: "Long", bpm: 60, bars: 8, repeat: 8, parts: [{ instrument: "pad", pattern: "C4 - - -" }] });
    expect(passSeconds(60, 8)).toBe(32);
    expect(track.repeat).toBe(1);
    expect(track.parts[0]?.volume).toBe(0.8);
    for (const [id, piece] of Object.entries(MUSIC_LIBRARY)) {
      const parsed = musicTrackSchema.parse(piece);
      expect(passSeconds(parsed.bpm, parsed.bars) * parsed.repeat, id).toBeLessThanOrEqual(MAX_TRACK_SECONDS);
    }
  });
});

describe("game, effect and music messages", () => {
  it("round-trips the new stage messages", () => {
    const track = musicTrackSchema.parse(MUSIC_LIBRARY["funk-beat"]);
    const messages = [
      { v: 1, t: "speak", id: "c1", text: "Here we go!", emotion: "proud", audioUrl: null, durationMs: 900, fx: ["confetti", "spin"] },
      { v: 1, t: "fx", fx: "fireworks", intensity: 2 },
      { v: 1, t: "music", track },
      { v: 1, t: "music", track: null },
      { v: 1, t: "sfx", sound: "win" },
      { v: 1, t: "game", scene: null },
      {
        v: 1,
        t: "game",
        scene: { kind: "number", round: 1, rounds: 3, phase: "open", remainingMs: 5000, durationMs: 60000, min: 1, max: 100, low: 20, high: 64, guesses: 4, last: { name: "ana", value: 19, hint: "higher" }, answer: null, winner: null },
      },
      { v: 1, t: "game", scene: { kind: "scoreboard", title: "Trivia: final scores", rows: [{ name: "ana", points: 15 }] } },
    ];
    for (const message of messages) expect(parseMessage(stageServerMessageSchema, JSON.stringify(message))).toEqual(message as never);
    expect(parseMessage(stageServerMessageSchema, { v: 1, t: "fx", fx: "explode" })).toBeUndefined();
    expect(parseMessage(stageServerMessageSchema, { v: 1, t: "sfx", sound: "foghorn" })).toBeUndefined();
  });

  it("validates game scenes and studio game and music commands", () => {
    expect(gameSceneSchema.safeParse({ kind: "trivia", round: 1, rounds: 1, phase: "open", remainingMs: 1, durationMs: 1, question: "Q?", options: ["only one"], answers: 0, tally: null, correct: null, winners: [] }).success).toBe(false);
    const command = (c: unknown) => parseMessage(studioClientMessageSchema, { v: 1, t: "command", id: "a", command: c });
    expect(command({ kind: "game_start", game: { kind: "riddle" } })?.command).toEqual({ kind: "game_start", game: { kind: "riddle", rounds: 5 } });
    expect(command({ kind: "game_start", game: { kind: "chess" } })).toBeUndefined();
    expect(command({ kind: "music_play", library: "lofi-night" })).toBeDefined();
    expect(command({ kind: "music_play", library: "not-a-song" })).toBeUndefined();
    expect(command({ kind: "music_stop" })).toBeDefined();
  });
});

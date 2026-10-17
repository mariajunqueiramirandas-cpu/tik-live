import { z } from "zod";

/**
 * Music as code (ADR-0024). The host writes short original pieces in a tiny
 * step-sequencer language and the stage synthesizes them live, so music is
 * part of the stage's audio (OBS and the cloud broadcast both carry it) and
 * there are no recordings and no licensed songs.
 *
 * A track is a few parts, one per instrument. A part's pattern is a list of
 * steps separated by spaces; a step is a sixteenth note (four per beat,
 * sixteen per bar):
 *
 *   .           rest
 *   -           hold the previous note one more step
 *   x           a hit (drums), or the part's default note (melodic parts)
 *   C4 D#3 Bb2  a note: letter, optional # or b, octave 0-8
 *   C4+E4+G4    a chord of up to four notes
 *   |           bar line, ignored (for readability)
 *
 * A pattern shorter than the track loops to fill it, so a one-bar drum
 * pattern under a four-bar melody repeats four times.
 */
export const INSTRUMENTS = ["lead", "pluck", "bass", "pad", "bell", "keys", "kick", "snare", "hat", "clap", "perc"] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

export const DRUMS: ReadonlySet<Instrument> = new Set(["kick", "snare", "hat", "clap", "perc"]);

export const STEPS_PER_BAR = 16;
/** Longest piece the stage will play, repeats included. */
export const MAX_TRACK_SECONDS = 45;
const MAX_STEPS = 8 * STEPS_PER_BAR;

const NOTE = "[A-G](?:#|b)?[0-8]";
const STEP = new RegExp(`^(?:\\.|-|x|${NOTE}(?:\\+${NOTE}){0,3})$`);

export const musicPartSchema = z.object({
  instrument: z.enum(INSTRUMENTS),
  pattern: z
    .string()
    .trim()
    .min(1)
    .max(600)
    .refine((pattern) => parsePattern(pattern) !== null, "Steps are . - x, a note like C4 or Bb2, or a chord like C4+E4+G4"),
  /** 0 to 1. */
  volume: z.number().min(0).max(1).default(0.8),
});
export type MusicPart = z.infer<typeof musicPartSchema>;

export const musicTrackSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    bpm: z.number().int().min(60).max(180),
    /** Length of one pass, in bars. */
    bars: z.number().int().min(1).max(8),
    /** How many times the whole piece plays. */
    repeat: z.number().int().min(1).max(8).default(1),
    /** "swing" pushes every other sixteenth late, 0 (straight) to 0.6. */
    swing: z.number().min(0).max(0.6).default(0),
    parts: z.array(musicPartSchema).min(1).max(8),
  })
  .transform((track) => ({ ...track, repeat: Math.max(1, Math.min(track.repeat, maxRepeats(track.bpm, track.bars))) }));
export type MusicTrack = z.output<typeof musicTrackSchema>;
export type MusicTrackInput = z.input<typeof musicTrackSchema>;

/** One parsed step: a rest, a hold, a hit, or notes as MIDI numbers. */
export type Step = { kind: "rest" } | { kind: "hold" } | { kind: "hit" } | { kind: "notes"; midi: number[] };

/** Parses a pattern, or returns null when it isn't valid. */
export function parsePattern(pattern: string): Step[] | null {
  const tokens = pattern.split(/\s+/).filter((token) => token && token !== "|");
  if (tokens.length === 0 || tokens.length > MAX_STEPS) return null;
  const steps: Step[] = [];
  for (const token of tokens) {
    if (!STEP.test(token)) return null;
    if (token === ".") steps.push({ kind: "rest" });
    else if (token === "-") steps.push({ kind: "hold" });
    else if (token === "x") steps.push({ kind: "hit" });
    else steps.push({ kind: "notes", midi: token.split("+").map(noteToMidi) });
  }
  return steps;
}

const SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "A4" → 69. Assumes a token that matched the step grammar. */
export function noteToMidi(note: string): number {
  const letter = SEMITONE[note[0] as string] as number;
  const accidental = note[1] === "#" ? 1 : note[1] === "b" ? -1 : 0;
  const octave = Number(note[note.length - 1]);
  return 12 * (octave + 1) + letter + accidental;
}

export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** Seconds one pass of a track takes. */
export function passSeconds(bpm: number, bars: number): number {
  return (bars * STEPS_PER_BAR * 60) / (bpm * 4);
}

function maxRepeats(bpm: number, bars: number): number {
  return Math.max(1, Math.floor(MAX_TRACK_SECONDS / passSeconds(bpm, bars)));
}

/** Short sounds for show moments. The stage synthesizes them; no samples. */
export const SOUNDS = ["pop", "chime", "whoosh", "tick", "start", "reveal", "win", "fail", "fanfare", "drumroll", "applause", "levelup"] as const;
export type Sound = (typeof SOUNDS)[number];

/** Ready-made pieces: the studio can play them, and they show what the language looks like. */
export const MUSIC_LIBRARY: Record<string, MusicTrackInput> = {
  "lofi-night": {
    title: "Lo-fi for the night shift",
    bpm: 78,
    bars: 4,
    repeat: 2,
    swing: 0.25,
    parts: [
      { instrument: "keys", pattern: "D4+F4+A4+C5 - - - - - - - . . . . . . . . | G3+B3+D4+F4 - - - - - - - . . . . . . . . | C4+E4+G4+B4 - - - - - - - . . . . . . . . | A3+C4+E4+G4 - - - - - - - . . . . . . . .", volume: 0.5 },
      { instrument: "bass", pattern: "D2 - - . . . D2 . . . . . A1 - . . | G1 - - . . . G1 . . . . . D2 - . . | C2 - - . . . C2 . . . . . G1 - . . | A1 - - . . . A1 . . . . . E2 - . .", volume: 0.7 },
      { instrument: "kick", pattern: "x . . . . . . . x . x . . . . .", volume: 0.8 },
      { instrument: "snare", pattern: ". . . . x . . . . . . . x . . .", volume: 0.5 },
      { instrument: "hat", pattern: "x . x . x . x . x . x . x . x x", volume: 0.3 },
    ],
  },
  "funk-beat": {
    title: "Batidão",
    bpm: 130,
    bars: 2,
    repeat: 4,
    parts: [
      { instrument: "kick", pattern: "x . . x . . x . . . x . . . . . | x . . x . . x . . . x . x . . .", volume: 0.95 },
      { instrument: "snare", pattern: ". . . . x . . . . . . . x . . . | . . . . x . . . . . . . x . x .", volume: 0.6 },
      { instrument: "clap", pattern: ". . . . x . . . . . . . x . . .", volume: 0.5 },
      { instrument: "perc", pattern: ". . x . . x . . x . . x . . x .", volume: 0.4 },
      { instrument: "bass", pattern: "A1 . . A1 . . C2 . . . A1 . . . . . | A1 . . A1 . . E2 . . . D2 . C2 . . .", volume: 0.75 },
    ],
  },
  "synthwave-drive": {
    title: "Neon drive",
    bpm: 110,
    bars: 4,
    repeat: 2,
    parts: [
      { instrument: "pad", pattern: "A3+C4+E4 - - - - - - - - - - - - - - - | F3+A3+C4 - - - - - - - - - - - - - - - | C4+E4+G4 - - - - - - - - - - - - - - - | G3+B3+D4 - - - - - - - - - - - - - - -", volume: 0.45 },
      { instrument: "bass", pattern: "A1 A2 A1 A2 A1 A2 A1 A2 A1 A2 A1 A2 A1 A2 A1 A2 | F1 F2 F1 F2 F1 F2 F1 F2 F1 F2 F1 F2 F1 F2 F1 F2 | C2 C3 C2 C3 C2 C3 C2 C3 C2 C3 C2 C3 C2 C3 C2 C3 | G1 G2 G1 G2 G1 G2 G1 G2 G1 G2 G1 G2 G1 G2 G1 G2", volume: 0.6 },
      { instrument: "lead", pattern: "E5 - - . D5 - C5 - A4 - - - . . . . | . . . . C5 - D5 - E5 - G5 - E5 - - - | G5 - - . E5 - D5 - C5 - - - . . . . | B4 - - - D5 - - - B4 - - - . . . .", volume: 0.5 },
      { instrument: "kick", pattern: "x . . . x . . . x . . . x . . .", volume: 0.85 },
      { instrument: "snare", pattern: ". . . . x . . . . . . . x . . .", volume: 0.55 },
    ],
  },
  "game-show": {
    title: "Contestants, ready",
    bpm: 140,
    bars: 2,
    repeat: 2,
    parts: [
      { instrument: "lead", pattern: "C5 . E5 . G5 . C6 - - . G5 . C6 - - - | A5 . F5 . D5 . G5 - - . B4 . C5 - - -", volume: 0.55 },
      { instrument: "bass", pattern: "C2 . . C2 . . G1 . C2 . . C2 . . G1 . | F1 . . F1 . . G1 . C2 . . . G1 . . .", volume: 0.7 },
      { instrument: "kick", pattern: "x . . . x . . . x . . . x . . .", volume: 0.8 },
      { instrument: "hat", pattern: ". . x . . . x . . . x . . . x .", volume: 0.35 },
    ],
  },
  "music-box": {
    title: "Little music box",
    bpm: 96,
    bars: 2,
    repeat: 2,
    parts: [
      { instrument: "bell", pattern: "E5 . G5 . C6 . G5 . E5 . G5 . D6 - - . | C6 . B5 . A5 . G5 . F5 . E5 . C5 - - .", volume: 0.5 },
      { instrument: "pad", pattern: "C4+E4+G4 - - - - - - - - - - - - - - - | F3+A3+C4 - - - - - - - G3+B3+D4 - - - - - - -", volume: 0.3 },
    ],
  },
};

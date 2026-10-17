import type Anthropic from "@anthropic-ai/sdk";
import { INSTRUMENTS, musicTrackSchema, type MusicTrack } from "@tik-live/shared";

export const PLAY_MUSIC_TOOL_NAME = "play_music";

/**
 * The host's music tool (ADR-0024): the model writes a short original piece
 * in the stage's step-sequencer language and the stage synthesizes it. The
 * call is fire-and-forget: nothing is sent back to the model, the turn just
 * ends. The schema is strict for shape; musicTrackSchema checks the rest.
 */
export const PLAY_MUSIC_TOOL: Anthropic.Beta.BetaTool = {
  name: PLAY_MUSIC_TOOL_NAME,
  description: `Plays a short piece of ORIGINAL music on stage, synthesized live from a score you write. Use it when a viewer asks for a song, a beat or music, when you sing or rap (the beat plays under your voice), or for a big show moment. At most one piece per turn, and not again within a few minutes. Say your line first, then call the tool.

Score format: each part is one instrument with a pattern of steps separated by spaces. A step is a sixteenth note: 4 per beat, 16 per bar.
  .        rest
  -        hold the previous note for one more step
  x        a hit (use for drums: kick snare hat clap perc)
  C4 F#3 Bb2   a note (letter, optional # or b, octave 0-8)
  C4+E4+G4 a chord (up to 4 notes)
  |        optional bar line, ignored
A pattern shorter than the piece loops (a one-bar drum pattern repeats under a four-bar melody).

Instruments: ${INSTRUMENTS.join(", ")}. bass sounds best in octaves 1-2, pad/keys 3-4, lead/pluck/bell 4-6.
Keep it short: bars 1-4, bpm 70-150, repeat so the whole thing lasts 10-30 seconds. Use 2-5 parts. Stay in one key; simple, catchy motifs work best. Never copy a recognizable existing melody.

Example (a two-bar funk beat): {"title":"Batidão","bpm":130,"bars":2,"repeat":4,"swing":0,"parts":[{"instrument":"kick","pattern":"x . . x . . x . . . x . . . . . | x . . x . . x . . . x . x . . .","volume":0.9},{"instrument":"snare","pattern":". . . . x . . . . . . . x . . .","volume":0.6},{"instrument":"bass","pattern":"A1 . . A1 . . C2 . . . A1 . . . . . | A1 . . A1 . . E2 . . . D2 . C2 . . .","volume":0.7}]}`,
  strict: true,
  eager_input_streaming: true,
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A short, fun title shown on stage (under 40 characters)." },
      bpm: { type: "integer", description: "60 to 180." },
      bars: { type: "integer", description: "Length of one pass, 1 to 8 bars." },
      repeat: { type: "integer", description: "How many times the piece plays, 1 to 8." },
      swing: { type: "number", description: "0 for straight, up to 0.6 for a lazy swing." },
      parts: {
        type: "array",
        description: "1 to 8 parts.",
        items: {
          type: "object",
          properties: {
            instrument: { type: "string", enum: [...INSTRUMENTS] },
            pattern: { type: "string" },
            volume: { type: "number", description: "0 to 1." },
          },
          required: ["instrument", "pattern", "volume"],
          additionalProperties: false,
        },
      },
    },
    required: ["title", "bpm", "bars", "repeat", "swing", "parts"],
    additionalProperties: false,
  },
};

/** Validates a tool call's input; with eager streaming the API no longer does. */
export function readMusicCall(input: unknown): { ok: true; track: MusicTrack } | { ok: false; error: string } {
  const parsed = musicTrackSchema.safeParse(input);
  if (parsed.success) return { ok: true, track: parsed.data };
  return { ok: false, error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

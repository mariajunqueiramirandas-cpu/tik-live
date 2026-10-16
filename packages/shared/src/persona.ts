import { z } from "zod";

export const EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "laugh",
  "surprised",
  "thinking",
  "sad",
  "love",
  "mischief",
] as const;

export type Emotion = (typeof EMOTIONS)[number];
export const emotionSchema = z.enum(EMOTIONS);

/** "orb" draws the character; "voice-line" is a voice-only show with a glowing waveform. */
export const CHARACTER_KINDS = ["orb", "voice-line"] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #7CF5FF")
  .transform((value) => value.toUpperCase());

export const DEFAULT_LOOK = {
  character: "orb",
  primary: "#7CF5FF",
  secondary: "#FF5FD2",
  background: "#0B0420",
} as const satisfies { character: CharacterKind; primary: string; secondary: string; background: string };

export const lookSchema = z.object({
  character: z.enum(CHARACTER_KINDS).default(DEFAULT_LOOK.character),
  primary: hexColor.default(DEFAULT_LOOK.primary),
  secondary: hexColor.default(DEFAULT_LOOK.secondary),
  background: hexColor.default(DEFAULT_LOOK.background),
});

export type Look = z.infer<typeof lookSchema>;

export const segmentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Lowercase letters, numbers and dashes only"),
  title: z.string().trim().min(1).max(40),
  /** How long the segment runs before the director rotates to the next one. */
  minutes: z.number().min(1).max(120),
  /** What the host should do to fill time during this segment when chat is quiet. */
  prompt: z.string().trim().min(1).max(600),
});

export type Segment = z.infer<typeof segmentSchema>;

export const personaSchema = z.object({
  name: z.string().trim().min(1).max(32),
  tagline: z.string().trim().min(1).max(120),
  /** Who the character is: backstory, personality, quirks. */
  description: z.string().trim().min(1).max(2000),
  /** How the character talks. */
  style: z.string().trim().min(1).max(800),
  catchphrases: z.array(z.string().trim().min(1).max(80)).max(8).default([]),
  /** Extra persona-specific rules, appended to the built-in safety rules. */
  rules: z.array(z.string().trim().min(1).max(200)).max(12).default([]),
  /** Upper bound on sentences per turn (keeps the host snappy). */
  maxSentences: z.number().int().min(1).max(6).default(3),
  segments: z.array(segmentSchema).min(1).max(12),
  look: lookSchema.default({ ...DEFAULT_LOOK }),
});

export type Persona = z.infer<typeof personaSchema>;

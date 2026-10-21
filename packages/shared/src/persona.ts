import { z } from "zod";
import { segmentGameSchema } from "./game";
// Installs the pt-BR messages wherever schemas are used. A bare import kept here, not in
// index.ts: bundlers skip the barrel and go straight to the module that defines a symbol.
import "./zod-pt-br";

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
  "confused",
  "shy",
  "sleepy",
  "proud",
  "pout",
] as const;

export type Emotion = (typeof EMOTIONS)[number];
export const emotionSchema = z.enum(EMOTIONS);

/**
 * Visual reactions the stage can play (ADR-0023): particle bursts around the
 * character and moves the character makes. The host can cue them in its
 * lines with a tag like [confetti]; gifts, follows, likes and game wins
 * trigger them on their own.
 */
export const EFFECTS = [
  "confetti",
  "hearts",
  "sparkles",
  "fireworks",
  "stars",
  "notes",
  "bubbles",
  "spin",
  "jump",
  "shake",
  "spotlight",
  "rain",
  // Full hype mode (ADR-0046): RGB lights, lasers, "deal with it" sunglasses, hitmarkers and meme stamps.
  "mlg",
] as const;
export type Effect = (typeof EFFECTS)[number];
export const effectSchema = z.enum(EFFECTS);

/** "orb" draws the character; "voice-line" is a voice-only show with a glowing waveform. */
export const CHARACTER_KINDS = ["orb", "voice-line"] as const;
export type CharacterKind = (typeof CHARACTER_KINDS)[number];

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Use uma cor hexadecimal de 6 dígitos, como #7CF5FF")
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

/** An IANA time zone the runtime can format dates in, e.g. "America/Sao_Paulo". */
export const timeZoneSchema = z
  .string()
  .trim()
  .max(64)
  .refine((zone) => isTimeZone(zone), "Esse fuso horário não é reconhecido");

export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const segmentSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Só letras minúsculas, números e hífens"),
  title: z.string().trim().min(1).max(40),
  /** How long the segment runs before the director rotates to the next one. */
  minutes: z.number().min(1).max(120),
  /** What the host should do to fill time during this segment when chat is quiet. */
  prompt: z.string().trim().min(1).max(600),
  /** A chat minigame the host runs during this segment (ADR-0023). */
  game: segmentGameSchema.optional(),
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
  /**
   * The host plans the run of show by itself (ADR-0035): talk segments and
   * minigames, drawn again every loop. The creator's segments stay saved for
   * when it's turned off. Off when unset.
   */
  autoShow: z.boolean().optional(),
  /** Chat votes which minigame the run of show's last segment plays (ADR-0029). On when unset. */
  finalVote: z.boolean().optional(),
  /** Every few minutes a challenge for the room: a like rush, a comment rush or a free raffle (ADR-0040). On when unset. */
  challenges: z.boolean().optional(),
  /**
   * Now and then the stage shows how viewers can support the show (like,
   * follow, share, gifts) and the host explains it in a quiet moment
   * (ADR-0032). On when unset.
   */
  support: z.boolean().optional(),
  /**
   * The stream's like and gift goals, shown on stage and celebrated when
   * reached (ADR-0036). Shown when unset. A target the creator sets is the
   * first goal and the step to the next ones; unset, the targets climb on
   * their own.
   */
  goals: z
    .object({
      show: z.boolean(),
      likes: z.number().int().min(10).max(100_000_000).optional(),
      /** In diamonds. */
      gifts: z.number().int().min(10).max(10_000_000).optional(),
    })
    .optional(),
  look: lookSchema.default({ ...DEFAULT_LOOK }),
  /** What the stage may play besides the voice. Music and effects are on when unset; the DJ is off. */
  sound: z
    .object({
      /** The host may compose and play short pieces of music (ADR-0024). */
      music: z.boolean(),
      /** Short sounds for gifts, follows and games. */
      effects: z.boolean(),
      /** The automatic DJ plays recorded Creative Commons electronic tracks non-stop under the voice (ADR-0045). Off when unset. */
      dj: z.boolean().optional(),
    })
    .optional(),
  /** Where the host "lives" (IANA time zone), so it knows the local time. */
  timezone: timeZoneSchema.optional(),
});

export type Persona = z.infer<typeof personaSchema>;

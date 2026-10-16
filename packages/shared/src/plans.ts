/**
 * Plans and their limits (ADR-0013). Limits live in code so the API, the
 * runtime and the dashboard enforce them identically. Prices live in server
 * configuration because they are a business decision, not a code change.
 */

export const PLAN_IDS = ["free", "creator", "pro", "self-hosted"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Channels that can be live at the same time. */
  runningChannels: number;
  /** Channels that can exist (drafts included). */
  channels: number;
  /** Live hours per calendar month; Infinity means unlimited. */
  liveHoursPerMonth: number;
  cloudBroadcast: boolean;
  /** "default" = the platform's default voice only; "curated" = pick any voice. */
  voices: "default" | "curated";
  transcriptRetentionDays: number;
  /** Claude tokens (input + output) per live hour before the host goes react-only. */
  tokenBudgetPerHour: number;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** One line for the pricing table. */
  summary: string;
  limits: PlanLimits;
  /** Shown on the billing page. */
  highlights: string[];
  purchasable: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    summary: "Try a host on your own stream.",
    limits: {
      runningChannels: 1,
      channels: 2,
      liveHoursPerMonth: 5,
      cloudBroadcast: false,
      voices: "default",
      transcriptRetentionDays: 7,
      tokenBudgetPerHour: 400_000,
    },
    highlights: ["1 host live at a time", "5 live hours a month", "Default voice"],
    purchasable: false,
  },
  creator: {
    id: "creator",
    name: "Creator",
    summary: "For creators who stream most nights.",
    limits: {
      runningChannels: 2,
      channels: 5,
      liveHoursPerMonth: 150,
      cloudBroadcast: false,
      voices: "curated",
      transcriptRetentionDays: 90,
      tokenBudgetPerHour: 600_000,
    },
    highlights: ["2 hosts live at a time", "150 live hours a month", "Choose any voice", "90 days of transcripts"],
    purchasable: true,
  },
  pro: {
    id: "pro",
    name: "Pro",
    summary: "Run several hosts around the clock, no PC needed.",
    limits: {
      runningChannels: 5,
      channels: 20,
      liveHoursPerMonth: 600,
      cloudBroadcast: true,
      voices: "curated",
      transcriptRetentionDays: 365,
      tokenBudgetPerHour: 800_000,
    },
    highlights: ["5 hosts live at a time", "600 live hours a month", "Cloud broadcast (no PC)", "A year of transcripts"],
    purchasable: true,
  },
  "self-hosted": {
    id: "self-hosted",
    name: "Self-hosted",
    summary: "Billing is off on this server; every feature is unlocked.",
    limits: {
      runningChannels: Number.POSITIVE_INFINITY,
      channels: Number.POSITIVE_INFINITY,
      liveHoursPerMonth: Number.POSITIVE_INFINITY,
      cloudBroadcast: true,
      voices: "curated",
      transcriptRetentionDays: 365,
      tokenBudgetPerHour: Number.POSITIVE_INFINITY,
    },
    highlights: ["Everything unlocked"],
    purchasable: false,
  },
};

export function isUnlimited(value: number): boolean {
  return value === Number.POSITIVE_INFINITY;
}

/** JSON can't carry Infinity; limits travel as null meaning "unlimited". */
export type WireLimits = { [K in keyof PlanLimits]: PlanLimits[K] extends number ? number | null : PlanLimits[K] };

export function limitsToWire(limits: PlanLimits): WireLimits {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(limits)) {
    out[key] = typeof value === "number" && !Number.isFinite(value) ? null : value;
  }
  return out as WireLimits;
}

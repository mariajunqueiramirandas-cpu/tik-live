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
  /** Estimated AI spend (USD) per channel per UTC day before the host goes react-only. */
  dailySpendCapUsd: number;
}

/** Which Claude models a plan's hosts use (ADR-0012); a deployment can override both. */
export interface PlanModels {
  host: string;
  moderator: string;
}

export interface Plan {
  id: PlanId;
  name: string;
  /** One line for the pricing table. */
  summary: string;
  limits: PlanLimits;
  models: PlanModels;
  /** Shown on the billing page. */
  highlights: string[];
  purchasable: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Grátis",
    summary: "Experimente um apresentador na sua live.",
    limits: {
      runningChannels: 1,
      channels: 2,
      liveHoursPerMonth: 5,
      cloudBroadcast: false,
      voices: "default",
      transcriptRetentionDays: 7,
      tokenBudgetPerHour: 400_000,
      dailySpendCapUsd: 8,
    },
    // Defaults stay on Opus 5.5 until the owner picks per-plan models (ADR-0012).
    models: { host: "claude-opus-5-5", moderator: "claude-opus-5-5" },
    highlights: ["1 apresentador ao vivo por vez", "5 horas de live por mês", "Voz padrão"],
    purchasable: false,
  },
  creator: {
    id: "creator",
    name: "Criador",
    summary: "Para quem faz live quase toda noite.",
    limits: {
      runningChannels: 2,
      channels: 5,
      liveHoursPerMonth: 150,
      cloudBroadcast: false,
      voices: "curated",
      transcriptRetentionDays: 90,
      tokenBudgetPerHour: 600_000,
      dailySpendCapUsd: 60,
    },
    // Defaults stay on Opus 5.5 until the owner picks per-plan models (ADR-0012).
    models: { host: "claude-opus-5-5", moderator: "claude-opus-5-5" },
    highlights: ["2 apresentadores ao vivo por vez", "150 horas de live por mês", "Escolha qualquer voz", "Transcrições por 90 dias"],
    purchasable: true,
  },
  pro: {
    id: "pro",
    name: "Pro",
    summary: "Vários apresentadores no ar o dia todo, sem precisar de PC.",
    limits: {
      runningChannels: 5,
      channels: 20,
      liveHoursPerMonth: 600,
      cloudBroadcast: true,
      voices: "curated",
      transcriptRetentionDays: 365,
      tokenBudgetPerHour: 800_000,
      dailySpendCapUsd: 200,
    },
    // Defaults stay on Opus 5.5 until the owner picks per-plan models (ADR-0012).
    models: { host: "claude-opus-5-5", moderator: "claude-opus-5-5" },
    highlights: ["5 apresentadores ao vivo por vez", "600 horas de live por mês", "Transmissão pela nuvem (sem PC)", "Transcrições por um ano"],
    purchasable: true,
  },
  "self-hosted": {
    id: "self-hosted",
    name: "Servidor próprio",
    summary: "A cobrança está desligada neste servidor; tudo liberado.",
    limits: {
      runningChannels: Number.POSITIVE_INFINITY,
      channels: Number.POSITIVE_INFINITY,
      liveHoursPerMonth: Number.POSITIVE_INFINITY,
      cloudBroadcast: true,
      voices: "curated",
      transcriptRetentionDays: 365,
      tokenBudgetPerHour: Number.POSITIVE_INFINITY,
      dailySpendCapUsd: Number.POSITIVE_INFINITY,
    },
    // Defaults stay on Opus 5.5 until the owner picks per-plan models (ADR-0012).
    models: { host: "claude-opus-5-5", moderator: "claude-opus-5-5" },
    highlights: ["Tudo liberado"],
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

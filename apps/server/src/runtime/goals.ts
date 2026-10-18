import type { GoalKind, GoalView } from "@tik-live/shared";

/** Targets when the creator sets none: small enough to reach early, then climbing. Diamonds for gifts. */
const LADDER: Record<GoalKind, readonly number[]> = {
  likes: [500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000],
  gifts: [100, 250, 500, 1_000, 2_500, 5_000, 10_000],
};
/** Past the ladder's top, each goal is this much more. */
const BEYOND: Record<GoalKind, number> = { likes: 100_000, gifts: 10_000 };

/**
 * The next target above `value`: the next multiple of `step` when the
 * creator set one (5.000, 10.000, 15.000...), else the next rung of the ladder.
 */
export function nextTarget(kind: GoalKind, value: number, step?: number): number {
  if (step) return (Math.floor(value / step) + 1) * step;
  const rung = LADDER[kind].find((target) => target > value);
  if (rung !== undefined) return rung;
  return (Math.floor(value / BEYOND[kind]) + 1) * BEYOND[kind];
}

export interface GoalReached {
  kind: GoalKind;
  /** The goal just reached (the highest one, when one jump passed several). */
  target: number;
  next: number;
  /** The new goal's number: 2 after the first is reached. */
  level: number;
}

/**
 * The stream's like and gift goals (ADR-0036). Each has a target; when the
 * count reaches it, the goal is reached and the next one is set right away,
 * so the bar on stage is never stuck full.
 */
export class StreamGoals {
  private readonly goals: Record<GoalKind, { target: number; level: number; step: number | undefined }>;
  private readonly values: Record<GoalKind, number> = { likes: 0, gifts: 0 };

  constructor(steps: Partial<Record<GoalKind, number>> = {}) {
    this.goals = {
      likes: { target: steps.likes ?? nextTarget("likes", 0), level: 1, step: steps.likes },
      gifts: { target: steps.gifts ?? nextTarget("gifts", 0), level: 1, step: steps.gifts },
    };
  }

  /** The new count for a goal. Returns the goal reached, if this count reached one. */
  update(kind: GoalKind, value: number): GoalReached | null {
    const goal = this.goals[kind];
    this.values[kind] = value;
    if (value < goal.target) return null;
    // One gift can pass several goals: the highest one reached is the one to celebrate.
    let target = goal.target;
    while (nextTarget(kind, target, goal.step) <= value) target = nextTarget(kind, target, goal.step);
    goal.target = nextTarget(kind, value, goal.step);
    goal.level += 1;
    return { kind, target, next: goal.target, level: goal.level };
  }

  /** Takes a count without celebrating: joining a stream that already has likes, say. */
  baseline(kind: GoalKind, value: number): void {
    this.values[kind] = value;
    const goal = this.goals[kind];
    if (value >= goal.target) goal.target = nextTarget(kind, value, goal.step);
  }

  /** The creator changed a target: the current goal follows it, without celebrating what's already in. */
  setSteps(steps: Partial<Record<GoalKind, number>>): boolean {
    let changed = false;
    for (const kind of ["likes", "gifts"] as const) {
      const goal = this.goals[kind];
      if (goal.step === steps[kind]) continue;
      goal.step = steps[kind];
      // The first goal is the creator's number; later ones are its next multiple.
      goal.target = goal.level === 1 && goal.step && goal.step > this.values[kind] ? goal.step : nextTarget(kind, this.values[kind], goal.step);
      changed = true;
    }
    return changed;
  }

  /** A new stream: counts and goals start over. */
  reset(): void {
    for (const kind of ["likes", "gifts"] as const) {
      const goal = this.goals[kind];
      this.values[kind] = 0;
      goal.target = goal.step ?? nextTarget(kind, 0);
      goal.level = 1;
    }
  }

  view(): GoalView[] {
    return (["likes", "gifts"] as const).map((kind) => ({ kind, value: this.values[kind], target: this.goals[kind].target, level: this.goals[kind].level }));
  }

  /** For the host's brief: "likes 3,240 of 5,000 (goal 2); gifts 120 of 500 diamonds (goal 1)". */
  describe(): string {
    const en = (n: number) => n.toLocaleString("en-US");
    const { likes, gifts } = this.goals;
    return `likes ${en(this.values.likes)} of ${en(likes.target)} (goal ${likes.level}); gifts ${en(this.values.gifts)} of ${en(gifts.target)} diamonds (goal ${gifts.level})`;
  }
}

import type { ViewerRecord } from "./memory";

/**
 * Fan levels (ADR-0037): every viewer climbs by coming back, chatting,
 * following, sharing and gifting, across streams. Worked out from what the
 * viewer memory already keeps, so there's nothing new to store.
 */

/** Messages count toward a level up to this many per stream the viewer came to, so spam can't farm it. */
const MESSAGES_PER_VISIT = 30;
/** Shares count up to this many per stream. */
const SHARES_PER_VISIT = 3;
export const MAX_FAN_LEVEL = 99;

type Counts = Pick<ViewerRecord, "visits" | "messages" | "diamonds" | "follows" | "shares">;

/** Points toward the next level: a stream visit 25, a message 2, following 40, a share 15, a diamond 3. */
export function fanXp(r: Counts): number {
  return (
    r.visits * 25 +
    Math.min(r.messages, r.visits * MESSAGES_PER_VISIT) * 2 +
    Math.min(r.follows, 1) * 40 +
    Math.min(r.shares, r.visits * SHARES_PER_VISIT) * 15 +
    r.diamonds * 3
  );
}

/** Points a level starts at: 0, 50, 150, 300, 500... each level a little further than the last. */
export function xpForLevel(level: number): number {
  return 25 * level * (level - 1);
}

export function fanLevel(xp: number): number {
  return Math.min(MAX_FAN_LEVEL, Math.max(1, Math.floor((1 + Math.sqrt(1 + (4 * xp) / 25)) / 2)));
}

/** A viewer's level, from their record. */
export function levelOf(record: Counts | undefined): number {
  return record ? fanLevel(fanXp(record)) : 1;
}

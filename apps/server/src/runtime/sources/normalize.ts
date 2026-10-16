import type { LiveEvent, Viewer } from "@tik-live/shared";

/**
 * Maps raw tiktok-live-connector payloads to LiveEvents.
 *
 * The connector is reverse-engineered and its payload shapes drift between
 * versions (e.g. v3 protos use `content` / `gift.name` / `count`, older docs
 * show `comment` / `giftDetails.giftName` / `likeCount`). Every field is read
 * defensively from all known spellings so a schema change degrades to a
 * dropped event instead of a crash.
 */

type Raw = Record<string, unknown>;

function obj(value: unknown): Raw | undefined {
  return value !== null && typeof value === "object" ? (value as Raw) : undefined;
}

function str(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number" || typeof v === "bigint") return String(v);
  }
  return "";
}

function num(...values: unknown[]): number {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    if (typeof v === "bigint") return Number(v);
  }
  return 0;
}

export function normalizeViewer(rawUser: unknown): Viewer | undefined {
  const u = obj(rawUser);
  if (!u) return undefined;
  const handle = str(u.uniqueId, u.displayId, u.username);
  const id = str(u.userId, u.id, handle);
  if (!id) return undefined;
  return { id, handle: handle || id, nickname: str(u.nickname, handle) };
}

export function normalizeChat(raw: unknown, at = Date.now()): LiveEvent | undefined {
  const r = obj(raw);
  const viewer = normalizeViewer(r?.user);
  const text = str(r?.comment, r?.content).trim();
  if (!viewer || !text) return undefined;
  return { kind: "chat", at, viewer, text };
}

export function normalizeQuestion(raw: unknown, at = Date.now()): LiveEvent | undefined {
  const r = obj(raw);
  const details = obj(r?.details) ?? obj(r?.questionDetails);
  const viewer = normalizeViewer(details?.user ?? r?.user);
  const text = str(details?.content, details?.questionText, r?.questionText, r?.content).trim();
  if (!viewer || !text) return undefined;
  return { kind: "question", at, viewer, text };
}

/** True while a streakable gift combo is still running (only the final event should count). */
export function isGiftStreakInProgress(raw: unknown): boolean {
  const r = obj(raw);
  const gift = obj(r?.gift);
  const details = obj(r?.giftDetails);
  const giftType = num(details?.giftType, gift?.type);
  return giftType === 1 && !r?.repeatEnd;
}

export function normalizeGift(raw: unknown, at = Date.now()): LiveEvent | undefined {
  const r = obj(raw);
  if (!r || isGiftStreakInProgress(r)) return undefined;
  const viewer = normalizeViewer(r.user);
  if (!viewer) return undefined;
  const gift = obj(r.gift);
  const details = obj(r.giftDetails);
  const extended = obj(r.extendedGiftInfo);
  const giftName = str(details?.giftName, gift?.name, extended?.name) || "gift";
  const unit = num(details?.diamondCount, gift?.diamondCount, extended?.diamond_count);
  const count = Math.max(1, num(r.repeatCount, r.comboCount, 1));
  return { kind: "gift", at, viewer, giftName, count, diamonds: unit * count };
}

export function normalizeLike(raw: unknown, at = Date.now()): LiveEvent | undefined {
  const r = obj(raw);
  const viewer = normalizeViewer(r?.user);
  if (!viewer) return undefined;
  const count = num(r?.likeCount, r?.count);
  const total = num(r?.totalLikeCount, r?.total);
  return { kind: "like", at, viewer, count: Math.max(1, count), ...(total ? { total } : {}) };
}

export function normalizeViewerCount(raw: unknown, at = Date.now()): LiveEvent | undefined {
  const r = obj(raw);
  const count = num(r?.viewerCount, r?.total, r?.totalUser);
  if (!count) return undefined;
  return { kind: "viewers", at, count };
}

export function normalizeSimple(
  kind: "follow" | "share" | "join",
  raw: unknown,
  at = Date.now(),
): LiveEvent | undefined {
  const viewer = normalizeViewer(obj(raw)?.user);
  if (!viewer) return undefined;
  return { kind, at, viewer };
}

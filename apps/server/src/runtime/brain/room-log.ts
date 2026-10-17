import type { LiveEvent } from "@tik-live/shared";

/** One thing that happened in the room, for the host's short-term memory. */
export type RoomEntry =
  | { at: number; kind: "viewer"; event: Extract<LiveEvent, { kind: "chat" | "question" }> }
  | { at: number; kind: "support"; event: Extract<LiveEvent, { kind: "gift" | "follow" | "share" }> }
  | { at: number; kind: "host"; text: string }
  /** Something the show itself did: a game round revealed, a segment started. */
  | { at: number; kind: "show"; text: string };

const MAX_ENTRIES = 60;
/** Older than this, a moment is no longer "the conversation". */
const MAX_AGE_MS = 20 * 60 * 1000;

/**
 * The recent conversation, viewers and host interleaved, oldest first. Each
 * host turn is a stateless request, so this is what lets the host follow a
 * thread, remember what it already asked, and not greet someone twice.
 *
 * Only chat that passed triage's input rules is kept: it ends up in the
 * prompt, so it must meet the same bar as the live events.
 */
export class RoomLog {
  private entries: RoomEntry[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  add(entry: RoomEntry): void {
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
  }

  /** The newest `max` entries still worth remembering, oldest first. */
  recent(max: number): RoomEntry[] {
    const cutoff = this.now() - MAX_AGE_MS;
    const fresh = this.entries.filter((entry) => entry.at >= cutoff);
    return fresh.slice(-max);
  }

  clear(): void {
    this.entries = [];
  }
}

import { clip, type LiveEvent } from "@tik-live/shared";
import { escapeForPrompt } from "../safety/gate";
import type { ViewerMemory } from "./memory";
import { displayName } from "./prompt";

/** Why one of the host's own lines never made it to air. */
export type UnsaidReason = "cut" | "blocked" | "skipped" | "repeat";

/** One thing that happened in the room, in the order it happened. */
export type RoomEntry =
  | { at: number; kind: "viewer"; event: Extract<LiveEvent, { kind: "chat" | "question" }> }
  | { at: number; kind: "support"; event: Extract<LiveEvent, { kind: "gift" | "follow" | "share" | "join" }> }
  /** Something the show itself did: a game round revealed, a segment started, music played. */
  | { at: number; kind: "show"; text: string }
  /** Lines the host wrote that viewers never heard. */
  | { at: number; kind: "unsaid"; why: UnsaidReason; lines: string[] };

/** One committed turn: what the host saw, what the director asked for, and what the host said. */
export interface Exchange {
  id: number;
  at: number;
  /** Ids of the room entries this turn showed. */
  ids: number[];
  /** The room entries the room block covered, for the chronicler. */
  entries: RoomEntry[];
  /** Rendered once and never again, so the cached prefix stays byte-identical. */
  room: string;
  brief: string;
  /** What the host said, one line per sentence, emotion tags included. */
  reply: string;
}

/** What a turn hands the model: the show so far, then this turn's room and brief. */
export interface TurnContext {
  /** The show before the first exchange (a summary), or "". */
  head: string;
  history: ReadonlyArray<Pick<Exchange, "room" | "brief" | "reply">>;
  room: string;
  brief: string;
}

/** The next turn's room block, not yet part of the conversation. */
export interface Draft {
  room: string;
  entries: RoomEntry[];
  /** Pending entries up to this id are covered (shown, or counted as scrolled by). */
  throughId: number;
  /** Ids this room shows. */
  shown: ReadonlySet<number>;
  /** Viewer events this room counted as scrolled by: the host never sees them. */
  scrolledBy: LiveEvent[];
  /** Viewer descriptions this room showed, remembered once the turn commits. */
  described: Map<string, string>;
  generation: number;
}

/** The most room entries one turn shows; the rest are counted as scrolled by. */
const ROOM_MAX_CHAT = 16;
const ROOM_MAX_SUPPORT = 10;
/** Entries kept waiting for a turn, at most (the oldest chat goes first). */
const MAX_PENDING = 200;
/** Rough characters per token, for budgeting the conversation (mixed languages, Claude tokenizer). */
const CHARS_PER_TOKEN = 3;
/** How much the recap of turns dropped without a summary keeps of each kind. */
const RECAP_MAX = { viewers: 20, gifts: 8, questions: 3, shows: 4, text: 100 };
const UNSAID_WHY: Record<UnsaidReason, string> = {
  cut: "cut before it aired: something more urgent came in",
  blocked: "blocked by the safety filter, never aired",
  skipped: "skipped by the channel owner",
  repeat: "you'd said this already, so it was dropped",
};

export interface ConversationOptions {
  memory: ViewerMemory;
  blocklist: () => readonly string[];
}

/**
 * The show as one append-only conversation (ADR-0026). Each committed turn
 * is a user message with the room since the last turn, the director's brief,
 * and the host's reply. Old turns are never re-rendered, so every request
 * shares the previous request's prefix byte for byte and the model reads it
 * from the prompt cache; only the new room, brief and reply are fresh.
 *
 * Things that happen between turns wait in `pending` until a turn shows
 * them, so the host sees every moment exactly once and in the order it
 * happened, interleaved with its own lines in the order it said them.
 */
export class Conversation {
  private pending: Array<{ id: number; entry: RoomEntry }> = [];
  private exchanges: Exchange[] = [];
  private head = "";
  /** Turns that left without a summary to fold into, so the host keeps the thread of the show. */
  private recap: Recap | null = null;
  private nextEntryId = 1;
  private nextExchangeId = 1;
  private readonly ids = new WeakMap<LiveEvent, number>();
  /** Viewer descriptions already in the conversation, so each is shown once (and again when it changes). */
  private described = new Map<string, string>();
  /** Bumps on reset, so a turn written for the previous stream can't commit into this one. */
  private generation = 0;
  /** The newest entry a draft has rendered; entries after it can still change. */
  private draftedThrough = 0;
  /** Ids shown in the conversation's rooms, so a brief only ever points at something the model can read. */
  private seen = new Set<number>();
  /** The original events folded into a pending gift-combo entry. */
  private readonly merged = new Map<number, LiveEvent[]>();

  constructor(private readonly options: ConversationOptions) {}

  /** Records something that happened; it shows up in the next turn's room. Returns its id. */
  add(entry: RoomEntry): number {
    // A gift combo is one line in the room, not one per tap.
    if (entry.kind === "support" && entry.event.kind === "gift") {
      const gift = entry.event;
      const same = this.pending.findLast(
        (item) =>
          item.id > this.draftedThrough &&
          item.entry.kind === "support" &&
          item.entry.event.kind === "gift" &&
          item.entry.event.viewer.id === gift.viewer.id &&
          item.entry.event.giftName === gift.giftName,
      );
      if (same?.entry.kind === "support" && same.entry.event.kind === "gift") {
        const combined = { ...same.entry.event, count: same.entry.event.count + gift.count, diamonds: same.entry.event.diamonds + gift.diamonds };
        if (!this.merged.has(same.id)) this.merged.set(same.id, [same.entry.event]);
        this.merged.get(same.id)?.push(gift);
        same.entry = { ...same.entry, event: combined };
        this.ids.set(combined, same.id);
        this.ids.set(gift, same.id);
        return same.id;
      }
    }
    const id = this.nextEntryId++;
    if ("event" in entry) this.ids.set(entry.event, id);
    this.pending.push({ id, entry });
    if (this.pending.length > MAX_PENDING) {
      const chat = this.pending.findIndex((item) => item.entry.kind === "viewer");
      const [removed] = this.pending.splice(chat === -1 ? 0 : chat, 1);
      if (removed) this.merged.delete(removed.id);
    }
    return id;
  }

  /**
   * How a turn's brief refers to a live event: "e12". Only for events the
   * model can read: in a room still in the conversation, or in `draft`.
   */
  ref(event: LiveEvent, draft?: Draft): string | undefined {
    const id = this.ids.get(event);
    if (id === undefined || !(this.seen.has(id) || draft?.shown.has(id))) return undefined;
    return `e${id}`;
  }

  /** True when the host has seen the event in a room, or will in the next one. */
  canShow(event: LiveEvent): boolean {
    const id = this.ids.get(event);
    return id !== undefined && (this.seen.has(id) || this.pending.some((item) => item.id === id));
  }

  /**
   * True when a reply the host wrote once it could see `event` names its
   * viewer: the host already got to them, so nothing should send it back.
   * Viewers called "visitante" can't be told apart, so they never count.
   */
  addressed(event: LiveEvent): boolean {
    const id = this.ids.get(event);
    if (id === undefined || !("viewer" in event)) return false;
    const name = spoken(displayName(event.viewer, this.options.blocklist()));
    if (!name || name === "visitante") return false;
    // The host may shorten a long nickname to its first word ("Ana Clara" -> "Ana").
    const first = name.split(" ")[0] as string;
    const forms = first !== name && first.length >= 3 ? [name, first] : [name];
    const from = this.exchanges.findIndex((exchange) => exchange.ids.includes(id));
    if (from === -1) return false;
    return this.exchanges.slice(from).some((exchange) => {
      const reply = ` ${spoken(exchange.reply)} `;
      return forms.some((form) => reply.includes(` ${form} `));
    });
  }

  /** Moments waiting for the next turn. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** True when some viewer has said something the host has seen. */
  hasViewerChat(): boolean {
    return this.exchanges.some((exchange) => exchange.entries.some((entry) => entry.kind === "viewer"));
  }

  /**
   * Renders the room since the last committed turn. Events in `focus` are
   * always shown; on a busy stream the rest is trimmed to the newest chat and
   * the biggest gifts, and what's left out is counted as scrolled by.
   */
  draft(focus: ReadonlySet<LiveEvent> = new Set()): Draft {
    const pending = this.pending;
    const throughId = pending.at(-1)?.id ?? 0;
    this.draftedThrough = Math.max(this.draftedThrough, throughId);
    const shown = new Set<number>();
    const chat = pending.filter((item) => item.entry.kind === "viewer");
    const support = pending.filter((item) => item.entry.kind === "support");
    // By id: a gift combo's entry holds a merged event, not the ones the turn was given.
    const focusIds = new Set([...focus].map((event) => this.ids.get(event)));
    for (const item of pending) {
      if (item.entry.kind === "show" || item.entry.kind === "unsaid" || focusIds.has(item.id)) shown.add(item.id);
    }
    for (const item of chat.slice(-ROOM_MAX_CHAT)) shown.add(item.id);
    const diamonds = (item: (typeof pending)[number]) =>
      item.entry.kind === "support" && item.entry.event.kind === "gift" ? item.entry.event.diamonds : 0;
    for (const item of [...support].sort((a, b) => diamonds(b) - diamonds(a) || b.id - a.id).slice(0, ROOM_MAX_SUPPORT)) shown.add(item.id);

    const described = new Map<string, string>();
    const lines: string[] = [];
    const entries: RoomEntry[] = [];
    for (const item of pending) {
      if (!shown.has(item.id)) continue;
      entries.push(item.entry);
      lines.push(this.render(item.id, item.entry, described));
    }
    const hiddenChat = chat.filter((item) => !shown.has(item.id)).length;
    const hiddenSupport = support.filter((item) => !shown.has(item.id)).length;
    if (hiddenChat || hiddenSupport) {
      lines.push(`<scrolled_by chat="${hiddenChat}" gifts_and_follows="${hiddenSupport}"/>`);
    }
    const scrolledBy: LiveEvent[] = [];
    for (const item of [...chat, ...support]) {
      if (shown.has(item.id) || !("event" in item.entry)) continue;
      // Every event that maps to this entry (a combo's taps included).
      scrolledBy.push(item.entry.event, ...(this.merged.get(item.id) ?? []));
    }
    const room = `<room>\n${lines.length ? lines.join("\n") : "(nothing new: chat is quiet)"}\n</room>`;
    return { room, entries, throughId, shown, scrolledBy, described, generation: this.generation };
  }

  /** The conversation so far plus this turn's room and brief, as the model will see it. */
  context(draft: Draft, brief: string): TurnContext {
    return { head: this.fullHead(), history: [...this.exchanges], room: draft.room, brief };
  }

  /**
   * Appends a finished turn. Moments the draft covered leave `pending`;
   * moments that arrived while the turn was being written stay for the next.
   * Returns false when the draft belongs to a stream that has since ended.
   */
  commit(draft: Draft, brief: string, reply: string, at: number): boolean {
    if (draft.generation !== this.generation || !reply.trim()) return false;
    for (const item of this.pending) if (item.id <= draft.throughId) this.merged.delete(item.id);
    this.pending = this.pending.filter((item) => item.id > draft.throughId);
    for (const [viewerId, about] of draft.described) this.described.set(viewerId, about);
    if (this.described.size > 5_000) this.described.clear();
    for (const id of draft.shown) this.seen.add(id);
    this.exchanges.push({ id: this.nextExchangeId++, at, ids: [...draft.shown], entries: draft.entries, room: draft.room, brief, reply: reply.trim() });
    return true;
  }

  /** Committed turns after `id`, oldest first. */
  exchangesAfter(id: number): Exchange[] {
    return this.exchanges.filter((exchange) => exchange.id > id);
  }

  lastExchangeId(): number {
    return this.exchanges.at(-1)?.id ?? 0;
  }

  /** Estimated size of the conversation in tokens (the cached prefix the next turn reads). */
  tokens(): number {
    let chars = this.fullHead().length;
    for (const exchange of this.exchanges) chars += exchange.room.length + exchange.brief.length + exchange.reply.length;
    return Math.round(chars / CHARS_PER_TOKEN);
  }

  /** The conversation's actual size on the wire, in UTF-8 bytes: what a request body's limit counts. */
  bytes(): number {
    let bytes = Buffer.byteLength(this.fullHead());
    for (const exchange of this.exchanges) bytes += Buffer.byteLength(exchange.room) + Buffer.byteLength(exchange.brief) + Buffer.byteLength(exchange.reply);
    return bytes;
  }

  /** How many committed turns the conversation holds word for word. */
  turnCount(): number {
    return this.exchanges.length;
  }

  /**
   * Folds old turns into a summary: turns up to `throughId` leave the
   * conversation, except the newest `keep`, and `head` takes their place
   * (null keeps the current head, and the turns that leave go into the
   * recap instead, so what happened in them isn't lost). This rewrites the
   * cached prefix once, so it only happens when the conversation has grown
   * past its budget. Returns how many turns left.
   */
  roll(head: string | null, throughId: number, keep: number): number {
    const limit = Math.max(0, this.exchanges.length - keep);
    let drop = 0;
    while (drop < limit && (this.exchanges[drop] as Exchange).id <= throughId) drop++;
    if (drop === 0) return 0;
    const gone = this.exchanges.splice(0, drop);
    for (const exchange of gone) for (const id of exchange.ids) this.seen.delete(id);
    if (head !== null) this.head = head;
    else this.remember(gone);
    // The turns that introduced these viewers are gone: introduce them again.
    this.described.clear();
    return drop;
  }

  /** A new stream: an empty conversation that starts from `head` (e.g. what happened last time). */
  reset(head = ""): void {
    this.generation += 1;
    this.pending = [];
    this.exchanges = [];
    this.described.clear();
    this.seen.clear();
    this.merged.clear();
    this.draftedThrough = 0;
    this.head = head;
    this.recap = null;
  }

  /** The head the model reads: the summary (or last stream), then the recap of turns dropped since. */
  private fullHead(): string {
    const recap = this.recap ? renderRecap(this.recap) : "";
    return [this.head, recap].filter(Boolean).join("\n\n");
  }

  /** Folds turns leaving without a summary into the recap: who talked, who gave, what was asked, what happened. */
  private remember(exchanges: readonly Exchange[]): void {
    const recap = (this.recap ??= { turns: 0, viewers: [], gifts: new Map(), questions: [], shows: [], lastLine: "" });
    const name = (viewer: Extract<RoomEntry, { event: LiveEvent }>["event"]["viewer"]) => clip(displayName(viewer, this.options.blocklist()), 30);
    for (const exchange of exchanges) {
      recap.turns += 1;
      for (const entry of exchange.entries) {
        if (entry.kind === "viewer") {
          const who = name(entry.event.viewer);
          recap.viewers = [...recap.viewers.filter((v) => v !== who), who];
          if (entry.event.kind === "question") recap.questions = [...recap.questions, `${who}: ${clip(entry.event.text, RECAP_MAX.text)}`].slice(-RECAP_MAX.questions);
        } else if (entry.kind === "support" && entry.event.kind === "gift") {
          const who = name(entry.event.viewer);
          const key = `${who}\u0000${entry.event.giftName}`;
          const gift = recap.gifts.get(key) ?? { who, gift: entry.event.giftName, count: 0, diamonds: 0 };
          gift.count += entry.event.count;
          gift.diamonds += entry.event.diamonds;
          recap.gifts.set(key, gift);
        } else if (entry.kind === "show") {
          recap.shows = [...recap.shows, clip(entry.text, RECAP_MAX.text)].slice(-RECAP_MAX.shows);
        }
      }
      const last = exchange.reply.split("\n").at(-1)?.trim();
      if (last) recap.lastLine = clip(last, RECAP_MAX.text * 2);
    }
    recap.viewers = recap.viewers.slice(-RECAP_MAX.viewers * 4);
    // The biggest gifts are the ones worth remembering.
    recap.gifts = new Map([...recap.gifts].sort(([, a], [, b]) => b.diamonds - a.diamonds).slice(0, RECAP_MAX.gifts));
  }

  private render(id: number, entry: RoomEntry, described: Map<string, string>): string {
    switch (entry.kind) {
      case "show":
        return `<show>${escapeForPrompt(entry.text)}</show>`;
      case "unsaid":
        return `<unsaid why="${UNSAID_WHY[entry.why]}">${entry.lines.map((line) => `"${escapeForPrompt(line)}"`).join(" ")}</unsaid>`;
      case "viewer":
      case "support":
        return this.renderEvent(id, entry.event, described);
    }
  }

  private renderEvent(id: number, event: Extract<RoomEntry, { event: LiveEvent }>["event"], described: Map<string, string>): string {
    const viewer = event.viewer;
    const about = this.options.memory.describe(viewer.id);
    let who = `id="e${id}" from="${attr(displayName(viewer, this.options.blocklist()))}"`;
    if (this.described.get(viewer.id) !== about && described.get(viewer.id) !== about) {
      who += ` about="${attr(about)}"`;
      described.set(viewer.id, about);
    }
    switch (event.kind) {
      case "chat":
        return `<chat ${who}>${escapeForPrompt(event.text)}</chat>`;
      case "question":
        return `<question ${who}>${escapeForPrompt(event.text)}</question>`;
      case "gift":
        return `<gift ${who} gift="${attr(event.giftName)}" count="${event.count}" diamonds="${event.diamonds}"/>`;
      case "follow":
        return `<follow ${who}/>`;
      case "share":
        return `<share ${who}/>`;
      case "join":
        return `<join ${who}/>`;
    }
  }
}

interface Recap {
  turns: number;
  /** Who chatted, most recent last. */
  viewers: string[];
  gifts: Map<string, { who: string; gift: string; count: number; diamonds: number }>;
  questions: string[];
  shows: string[];
  lastLine: string;
}

function renderRecap(recap: Recap): string {
  const lines: string[] = [];
  const recent = recap.viewers.slice(-RECAP_MAX.viewers).reverse();
  if (recent.length) {
    const others = recap.viewers.length - recent.length;
    lines.push(`Talked with: ${recent.join(", ")}${others > 0 ? ` and ${others} others` : ""}.`);
  }
  if (recap.gifts.size) lines.push(`Gifts: ${[...recap.gifts.values()].map((g) => `${g.who} ${g.count}x ${g.gift}`).join(", ")}.`);
  if (recap.questions.length) lines.push(`Questions asked: ${recap.questions.map((q) => `"${q}"`).join("; ")}.`);
  if (recap.shows.length) lines.push(`On the show: ${recap.shows.join("; ")}.`);
  if (recap.lastLine) lines.push(`Your last line then: "${recap.lastLine}"`);
  return `<earlier turns="${recap.turns}">\n${escapeForPrompt(lines.join("\n") || "Nothing worth keeping.")}\n</earlier>`;
}

/** Words only, lowercase, one space apart: how a name is matched against what the host said. */
function spoken(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function attr(value: string | number): string {
  return escapeForPrompt(String(value)).replace(/"/g, "&quot;");
}

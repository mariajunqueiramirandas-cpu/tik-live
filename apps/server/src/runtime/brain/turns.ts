import Anthropic from "@anthropic-ai/sdk";
import { clip, viewerName, type LiveEvent, type Persona } from "@tik-live/shared";
import type { Logger } from "../../log";
import { escapeForPrompt } from "../safety/gate";
import { containsBlockedTerm, containsContactInfo, looksLikeInjection } from "../safety/rules";
import { asksForShoutout } from "../safety/sounds";
import type { CueMeta, SpeechPipeline } from "../voice/pipeline";
import type { Chronicler } from "./chronicle";
import { Conversation, PASS, type Draft, type UnsaidReason } from "./conversation";
import type { HostActions, HostBrain } from "./host";
import type { HostFacts } from "./host-facts";
import type { ViewerMemory } from "./memory";
import { buildBrief, type BriefRefs, type TurnKind, type TurnPlan, type TurnRequest } from "./prompt";
import type { Emotion, Utterance } from "./sentences";
import type { QueueItem } from "./triage";

/**
 * Past `softTokens` the conversation is folded into the show summary at the
 * next chronicle, keeping `keepTurns` turns word for word; past `hardTokens`
 * old turns go even without a summary. Kept small: every turn reads the
 * whole conversation (from the cache, but still).
 *
 * `maxRequestBytes` is a backstop above the hard limit (~96 KB of text plus
 * ~10 KB of system prompt and tools): a turn only compacts for it when one
 * room or reply is unusually large.
 */
const CONTEXT_BUDGET: ContextBudget = { softTokens: 16_000, hardTokens: 32_000, keepTurns: 8, maxRequestBytes: 140_000 };

export interface ContextBudget {
  softTokens: number;
  hardTokens: number;
  keepTurns: number;
  /** The most a whole request may weigh (conversation, room, brief, system prompt, tools); a turn compacts first rather than send more. */
  maxRequestBytes?: number;
}
/** The chronicler runs at most this often for viewer notes and the show summary, and only with enough new turns. */
const CHRONICLE_EVERY_MS = 4 * 60_000;
const CHRONICLE_MIN_TURNS = 6;
/** The most turns one chronicle reads. */
const CHRONICLE_MAX_TURNS = 40;
/** After a chronicle fails (or doesn't shrink the conversation), wait this long before the next. */
const CHRONICLE_RETRY_MS = 30_000;
/** A line the host already said this recently is dropped as a repeat. */
const REPEAT_WINDOW_MS = 10 * 60_000;
const REPEAT_MEMORY = 120;
/** A gift worth this many diamonds or more is the highlight of its turn. */
const BIG_GIFT_DIAMONDS = 100;
/** The longest a turn waits for viewers' stored memory to load before it describes them. */
const MEMORY_WAIT_MS = 150;

export interface TurnEngineOptions {
  host: HostBrain;
  speech: SpeechPipeline;
  memory: ViewerMemory;
  persona: () => Persona;
  blocklist: () => readonly string[];
  /** Keeps the show summary and notes about viewers; without it old turns are just dropped. */
  chronicler?: Chronicler;
  /** What the host has said about itself on this channel; the conversation's head carries it. */
  hostFacts?: HostFacts;
  actions?: HostActions;
  /** How the last stream went, for the first turn of this one. */
  lastStream?: string;
  /** When to fold the conversation, and how many turns to keep word for word (tests shrink it). */
  budget?: ContextBudget;
  onTurn?(turn: { id: string; kind: TurnKind; items: number }): void;
  /** The show summary changed (the runtime keeps it with the stream session). */
  onSummary?(summary: string): void;
  log?: Logger;
  now?: () => number;
}

export type TurnResult = ({ ok: true; lines: number } | { ok: false; error: unknown }) & {
  /** Viewer events the turn's room counted as scrolled by: the host never saw them, so nothing should ask it to answer them. */
  scrolledBy: LiveEvent[];
};

/**
 * Runs the host's turns (ADR-0026). Each turn: render the room since the
 * last turn and the director's brief, stream the reply sentence by sentence
 * into speech, and commit the turn to the conversation, so the next turn
 * reads this one from the prompt cache. It also keeps the conversation
 * honest about what aired: lines cut for something urgent, blocked by the
 * safety gate or skipped by the owner come back as <unsaid> notes, and a
 * line the host already said is dropped before it reaches the voice.
 */
export class TurnEngine {
  readonly conversation: Conversation;
  private current: { kind: TurnKind; abort: AbortController } | null = null;
  private counter = 0;
  private said: Array<{ key: string; words: Set<string>; at: number }> = [];
  private summary = "";
  private lastStream: string;
  private chronicledThrough = 0;
  private chronicledAt: number;
  private chronicling: AbortController | null = null;
  private chronicleRetryAt = 0;
  private readonly budget: ContextBudget;
  /** Requests refused in a row for their size: each one keeps fewer turns word for word. */
  private squeeze = 0;
  private readonly now: () => number;

  constructor(private readonly options: TurnEngineOptions) {
    this.now = options.now ?? Date.now;
    this.budget = options.budget ?? CONTEXT_BUDGET;
    this.chronicledAt = this.now();
    this.lastStream = options.lastStream ?? "";
    this.conversation = new Conversation({ memory: options.memory, blocklist: options.blocklist });
    this.conversation.reset(this.head(this.lastStreamBlock()));
  }

  /** The kind of turn being written right now, if any. */
  get inFlight(): TurnKind | null {
    return this.current?.kind ?? null;
  }

  /** The show summary so far (from the chronicler). */
  get showSummary(): string {
    return this.summary;
  }

  /** Stops writing the current turn. Lines already queued stay queued. */
  abort(): void {
    this.current?.abort.abort();
  }

  /** Writes one turn and queues its lines. Never throws: a failure is returned for the director's backoff. */
  async run(plan: TurnPlan): Promise<TurnResult> {
    const { speech, host } = this.options;
    const persona = this.options.persona();
    const abort = new AbortController();
    this.current = { kind: plan.kind, abort };
    const startedAt = this.now();
    const turnId = `t${++this.counter}`;
    this.options.onTurn?.({ id: turnId, kind: plan.kind, items: plan.items.length });

    // A viewer's stored memory loads in the background when they first show up; a regular whose first event is
    // the message this turn answers would be described as new. Wait for it, briefly: a slow store only costs memory.
    await within(this.options.memory.settled(), MEMORY_WAIT_MS);
    const focus = new Set<LiveEvent>(plan.items.flatMap((item) => item.events));
    const compose = () => {
      const draft = this.conversation.draft(focus);
      const brief = buildBrief(plan, this.refs(plan.items, draft), {
        maxSentences: persona.maxSentences,
        stillSpeaking: speech.upcoming().length > 0,
        lastStream: plan.kind === "opening" && this.lastStream !== "",
      });
      return { draft, brief };
    };
    let { draft, brief } = compose();
    // Compact before sending a request the API would refuse; the brief is rebuilt, as it may point at turns that left.
    if (this.fit(draft.room, brief)) ({ draft, brief } = compose());
    const { originAt, ...rest } = plan;
    const request: TurnRequest = { ...rest, context: this.conversation.context(draft, brief) };

    const reply: string[] = [];
    const said: string[] = [];
    const repeats: string[] = [];
    let emotion: Emotion | undefined;
    let error: unknown;
    try {
      for await (const utterance of host.generate(request, abort.signal, this.options.actions)) {
        if (abort.signal.aborted) break;
        const text = withoutRefs(utterance.text);
        if (!/[\p{L}\p{N}]/u.test(text)) continue;
        if (plan.kind !== "game" && this.isRepeat(text, persona)) {
          repeats.push(text);
          continue;
        }
        const line: Utterance = { ...utterance, text };
        const context = moderationContext(plan, said);
        speech.enqueue(line, {
          meta: { turnId, turnKind: plan.kind, originAt, first: said.length === 0, startedAt, writtenAt: this.now() },
          ...(context ? { context } : {}),
        });
        this.remember(text);
        reply.push(transcriptLine(line, emotion));
        emotion = line.emotion;
        said.push(text);
      }
    } catch (err) {
      if (!abort.signal.aborted) error = err;
    } finally {
      if (this.current?.abort === abort) this.current = null;
    }
    // The uncommitted room would be sent again unchanged, and the API would refuse it again: shrink what the next
    // turn carries, harder each time in a row (half the kept turns each time, down to the summary and recap only),
    // so whatever in the history the API can't take leaves it.
    if (error !== undefined && bodyRejected(error)) {
      this.squeeze += 1;
      const dropped = this.compact(this.budget.keepTurns >> this.squeeze);
      this.options.log?.warn(`the Claude API refused the request body; compacted ${dropped} turns (attempt ${this.squeeze})`);
    } else if (error === undefined) {
      this.squeeze = 0;
    }
    const at = this.now();
    if (repeats.length) this.conversation.add({ at, kind: "unsaid", why: "repeat", lines: repeats });
    // Even a failed or interrupted turn commits what it got out: those lines are on their way to air. A turn that
    // finished in silence ([pass], or only lines it had said already) read its room too: left uncommitted, the next
    // turn would show those messages again as new, and the host would answer them late.
    const finished = error === undefined && !abort.signal.aborted;
    const committed = this.conversation.commit(draft, brief, reply.length ? reply.join("\n") : finished ? PASS : "", at);
    const scrolledBy = committed ? draft.scrolledBy : [];
    return error === undefined ? { ok: true, lines: said.length, scrolledBy } : { ok: false, error, scrolledBy };
  }

  /** The host's own lines that never aired go into the next room, so it doesn't build on them. */
  unsaid(why: UnsaidReason, lines: ReadonlyArray<{ text: string; meta?: CueMeta | undefined; operator?: boolean }>): void {
    const own = lines.filter((line) => line.meta && !line.operator).map((line) => line.text);
    if (!own.length) return;
    this.conversation.add({ at: this.now(), kind: "unsaid", why, lines: own });
    // Not said, so not a repeat if it comes up again.
    const keys = new Set(own.map(normalize));
    this.said = this.said.filter((entry) => !keys.has(entry.key));
  }

  /**
   * Housekeeping between turns: every few minutes the chronicler updates the
   * show summary and notes about viewers; when the conversation outgrows its
   * budget, old turns fold into that summary. `routine` is false when the
   * host is saving budget: then only the folding that's needed happens.
   */
  maintain(now: number, routine: boolean): void {
    if (this.chronicling) return;
    const chronicler = this.options.chronicler;
    const fresh = this.conversation.exchangesAfter(this.chronicledThrough);
    const tokens = this.conversation.tokens();
    const over = tokens > this.budget.softTokens;
    const due = routine && now - this.chronicledAt >= CHRONICLE_EVERY_MS && fresh.length >= CHRONICLE_MIN_TURNS;
    if (!chronicler || !fresh.length || !(over || due) || now < this.chronicleRetryAt) {
      if (tokens > this.budget.hardTokens) this.dropOldTurns();
      return;
    }
    const covered = fresh.slice(-CHRONICLE_MAX_TURNS);
    const through = (covered.at(-1) as (typeof covered)[number]).id;
    const blocklist = this.options.blocklist();
    const abort = new AbortController();
    this.chronicling = abort;
    this.chronicledAt = now;
    void chronicler
      .update(this.summary, covered, abort.signal)
      .then((chronicle) => {
        if (abort.signal.aborted) return;
        if (!containsBlockedTerm(chronicle.summary, blocklist) && chronicle.summary.trim()) {
          this.summary = chronicle.summary.trim();
          this.options.onSummary?.(this.summary);
        }
        // Memory outlives the stream and goes back into prompts: nothing blocked, no contact details, nothing that reads like an instruction.
        const keep = (text: string) => !containsBlockedTerm(text, blocklist) && !containsContactInfo(text) && !looksLikeInjection(text);
        for (const note of chronicle.notes) {
          if (keep(`${note.topic ?? ""} ${note.note}`)) this.options.memory.addNote(note.viewerId, note.note, note.topic);
        }
        for (const fact of chronicle.hostFacts ?? []) {
          if (keep(`${fact.topic} ${fact.fact}`)) this.options.hostFacts?.learn(fact.topic, fact.fact);
        }
        this.chronicledThrough = through;
        if (this.conversation.tokens() > this.budget.softTokens) {
          const dropped = this.summary ? this.conversation.roll(this.head(this.summaryBlock()), through, this.budget.keepTurns) : 0;
          if (dropped) {
            this.options.log?.debug(`folded ${dropped} old turns into the show summary`);
          } else {
            // Still over budget (no usable summary, or nothing old enough to fold): don't chronicle again every turn.
            this.chronicleRetryAt = this.now() + CHRONICLE_RETRY_MS;
          }
        }
      })
      .catch((err: unknown) => {
        if (abort.signal.aborted) return;
        this.options.log?.warn("couldn't update the show summary", err);
        this.chronicleRetryAt = this.now() + CHRONICLE_RETRY_MS;
        if (this.conversation.tokens() > this.budget.hardTokens) this.dropOldTurns();
      })
      .finally(() => {
        if (this.chronicling === abort) this.chronicling = null;
      });
  }

  /** The stream went live: a fresh conversation that opens with how the last stream went. */
  startStream(): void {
    this.abort();
    this.chronicling?.abort();
    this.chronicling = null;
    this.summary = "";
    this.said = [];
    this.chronicledThrough = 0;
    this.chronicledAt = this.now();
    this.chronicleRetryAt = 0;
    this.conversation.reset(this.head(this.lastStreamBlock()));
  }

  /** The stream ended: what happened becomes "last stream" for the next one. */
  endStream(): void {
    this.abort();
    if (this.summary) this.lastStream = this.summary;
  }

  stop(): void {
    this.abort();
    this.chronicling?.abort();
    this.chronicling = null;
  }

  /** The conversation's head: what the host said about itself, then `block` (last stream, or the show so far). */
  private head(block: string): string {
    return [this.options.hostFacts?.render() ?? "", block].filter(Boolean).join("\n\n");
  }

  private lastStreamBlock(): string {
    return this.lastStream ? `<last_stream>\n${escapeForPrompt(this.lastStream)}\n</last_stream>` : "";
  }

  private summaryBlock(): string {
    return `<earlier>\n${escapeForPrompt(this.summary)}\n</earlier>`;
  }

  /** Past the hard limit, old turns leave even if the chronicler hasn't caught up. */
  private dropOldTurns(): void {
    const dropped = this.compact(this.budget.keepTurns);
    if (dropped) this.options.log?.debug(`dropped ${dropped} old turns from the conversation`);
  }

  /**
   * Keeps the newest `keep` turns word for word. Older turns the summary
   * covers fold into it; the rest go into the conversation's recap, so
   * nothing that happened is forgotten outright. Returns how many left.
   */
  private compact(keep: number): number {
    let dropped = 0;
    if (this.summary) dropped += this.conversation.roll(this.head(this.summaryBlock()), this.chronicledThrough, keep);
    dropped += this.conversation.roll(null, this.conversation.lastExchangeId(), keep);
    return dropped;
  }

  /** The whole request's size in bytes, as the API will receive it (near enough: JSON framing is small). */
  private requestBytes(room: string, brief: string): number {
    return this.conversation.bytes() + Buffer.byteLength(room) + Buffer.byteLength(brief) + (this.options.host.requestOverheadBytes?.() ?? 0);
  }

  /** Compacts until the request fits under `maxRequestBytes`, fewer turns kept each step. Returns true if anything left. */
  private fit(room: string, brief: string): boolean {
    const max = this.budget.maxRequestBytes;
    if (max === undefined || this.requestBytes(room, brief) <= max) return false;
    let dropped = 0;
    for (let keep = Math.min(this.budget.keepTurns, this.conversation.turnCount() - 1); keep >= 0; keep = keep > 1 ? keep >> 1 : keep - 1) {
      dropped += this.compact(keep);
      if (this.requestBytes(room, brief) <= max) break;
    }
    if (dropped) this.options.log?.info(`compacted ${dropped} turns to keep the request under ${Math.round(max / 1000)} KB`);
    return dropped > 0;
  }

  /** The brief's references for a turn's events, in the plan's order; only events the model can read. */
  private refs(items: QueueItem[], draft: Draft): BriefRefs {
    const refs: BriefRefs = { support: [], chat: [] };
    for (const item of items) {
      const ref = [...item.events].reverse().map((event) => this.conversation.ref(event, draft)).find(Boolean);
      if (!ref) continue;
      const kind = item.event.kind;
      const tags = item.tags?.length ? `, ${item.tags.join(", ")}` : "";
      if (item.event.kind === "chat" || item.event.kind === "question") refs.chat.push(`${ref} (${asksForShoutout(item.event.text) ? "shout-out request" : kind}${tags})`);
      else if (item.event.kind === "gift" && item.event.diamonds >= BIG_GIFT_DIAMONDS) refs.support.push(`${ref} (big gift${tags})`);
      else refs.support.push(`${ref} (${kind === "join" ? "returning viewer" : kind}${tags})`);
    }
    return refs;
  }

  private remember(text: string): void {
    const key = normalize(text);
    this.said.push({ key, words: new Set(key.split(" ")), at: this.now() });
    if (this.said.length > REPEAT_MEMORY) this.said.shift();
  }

  /** Same words as a line said in the last few minutes (catchphrases excepted). */
  private isRepeat(text: string, persona: Persona): boolean {
    const key = normalize(text);
    if (!key || persona.catchphrases.some((phrase) => normalize(phrase) === key)) return false;
    const cutoff = this.now() - REPEAT_WINDOW_MS;
    const words = new Set(key.split(" "));
    return this.said.some((entry) => entry.at >= cutoff && (entry.key === key || (words.size >= 6 && jaccard(words, entry.words) >= 0.9)));
  }
}

/** Waits for `promise`, but no longer than `ms`; never rejects. */
async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  try {
    await Promise.race([promise.catch(() => undefined), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The API refused the request body itself (malformed or too large): the same conversation would be refused again. */
function bodyRejected(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  return err.status === 413 || (err.status === 400 && /request body/i.test(err.message));
}

/** The model refers to events by id (e12) in its head, never out loud. */
function withoutRefs(text: string): string {
  return text
    .replace(/\(?\be\d{1,6}\b\)?/g, "")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** A line as it goes in the transcript: the emotion tag when it changes, effects after the words. */
function transcriptLine(line: Utterance, previous: Emotion | undefined): string {
  const tag = line.emotion !== (previous ?? "neutral") ? `[${line.emotion}] ` : "";
  const fx = line.fx?.length ? ` ${line.fx.map((effect) => `[${effect}]`).join(" ")}` : "";
  return `${tag}${line.text}${fx}`;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** What a line replies to, so the moderator reads it in context (ADR-0016). */
function moderationContext(plan: TurnPlan, said: string[]): string {
  const lines: string[] = [];
  for (const item of plan.items) {
    const event = item.event;
    if (event.kind === "chat" || event.kind === "question") lines.push(`Viewer ${clip(viewerName(event.viewer), 30)} wrote: ${event.text}`);
    else if (event.kind === "gift") lines.push(`Viewer ${clip(viewerName(event.viewer), 30)} sent ${event.count}x ${event.giftName}.`);
  }
  if (plan.kind === "game") lines.push("The host is running a chat quiz game and announcing a round.");
  if (plan.kind === "request") lines.push(`The channel owner asked the host: ${plan.note ?? ""}`);
  if (said.length) lines.push(`The host just said: ${said.slice(-2).join(" ")}`);
  return lines.join("\n");
}

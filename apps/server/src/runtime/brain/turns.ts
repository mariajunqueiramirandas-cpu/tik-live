import { viewerName, type LiveEvent, type Persona } from "@tik-live/shared";
import type { Logger } from "../../log";
import { escapeForPrompt } from "../safety/gate";
import { containsBlockedTerm } from "../safety/rules";
import type { CueMeta, SpeechPipeline } from "../voice/pipeline";
import type { Chronicler } from "./chronicle";
import { Conversation, type Draft, type UnsaidReason } from "./conversation";
import type { HostActions, HostBrain } from "./host";
import type { ViewerMemory } from "./memory";
import { buildBrief, type BriefRefs, type TurnKind, type TurnPlan, type TurnRequest } from "./prompt";
import type { Emotion, Utterance } from "./sentences";
import type { QueueItem } from "./triage";

/**
 * Past `softTokens` the conversation is folded into the show summary at the
 * next chronicle, keeping `keepTurns` turns word for word; past `hardTokens`
 * old turns go even without a summary. Kept small: every turn reads the
 * whole conversation (from the cache, but still).
 */
const CONTEXT_BUDGET = { softTokens: 14_000, hardTokens: 28_000, keepTurns: 6 };
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

export interface TurnEngineOptions {
  host: HostBrain;
  speech: SpeechPipeline;
  memory: ViewerMemory;
  persona: () => Persona;
  blocklist: () => readonly string[];
  /** Keeps the show summary and notes about viewers; without it old turns are just dropped. */
  chronicler?: Chronicler;
  actions?: HostActions;
  /** How the last stream went, for the first turn of this one. */
  lastStream?: string;
  /** When to fold the conversation, and how many turns to keep word for word (tests shrink it). */
  budget?: { softTokens: number; hardTokens: number; keepTurns: number };
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
  private readonly budget: { softTokens: number; hardTokens: number; keepTurns: number };
  private readonly now: () => number;

  constructor(private readonly options: TurnEngineOptions) {
    this.now = options.now ?? Date.now;
    this.budget = options.budget ?? CONTEXT_BUDGET;
    this.chronicledAt = this.now();
    this.lastStream = options.lastStream ?? "";
    this.conversation = new Conversation({ memory: options.memory, blocklist: options.blocklist });
    this.conversation.reset(this.lastStreamHead());
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

    const focus = new Set<LiveEvent>(plan.items.flatMap((item) => item.events));
    const draft = this.conversation.draft(focus);
    const brief = buildBrief(plan, this.refs(plan.items, draft), {
      maxSentences: persona.maxSentences,
      stillSpeaking: speech.upcoming().length > 0,
      lastStream: plan.kind === "opening" && this.lastStream !== "",
    });
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
    const at = this.now();
    if (repeats.length) this.conversation.add({ at, kind: "unsaid", why: "repeat", lines: repeats });
    // Even a failed or interrupted turn commits what it got out: those lines are on their way to air.
    const committed = this.conversation.commit(draft, brief, reply.join("\n"), at);
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
        for (const note of chronicle.notes) {
          if (!containsBlockedTerm(note.note, blocklist)) this.options.memory.addNote(note.viewerId, note.note);
        }
        this.chronicledThrough = through;
        if (this.conversation.tokens() > this.budget.softTokens) {
          const dropped = this.summary ? this.conversation.roll(`<earlier>\n${escapeForPrompt(this.summary)}\n</earlier>`, through, this.budget.keepTurns) : 0;
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
    this.conversation.reset(this.lastStreamHead());
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

  private lastStreamHead(): string {
    return this.lastStream ? `<last_stream>\n${escapeForPrompt(this.lastStream)}\n</last_stream>` : "";
  }

  /** Without a summary to fold into, the oldest turns just leave the conversation. */
  private dropOldTurns(): void {
    const dropped = this.conversation.roll(null, this.conversation.lastExchangeId(), this.budget.keepTurns);
    if (dropped) this.options.log?.debug(`dropped ${dropped} old turns from the conversation`);
  }

  /** The brief's references for a turn's events, in the plan's order; only events the model can read. */
  private refs(items: QueueItem[], draft: Draft): BriefRefs {
    const refs: BriefRefs = { support: [], chat: [] };
    for (const item of items) {
      const ref = [...item.events].reverse().map((event) => this.conversation.ref(event, draft)).find(Boolean);
      if (!ref) continue;
      const kind = item.event.kind;
      if (kind === "chat" || kind === "question") refs.chat.push(`${ref} (${kind})`);
      else refs.support.push(`${ref} (${kind === "join" ? "returning viewer" : kind})`);
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
    if (event.kind === "chat" || event.kind === "question") lines.push(`Viewer ${viewerName(event.viewer).slice(0, 30)} wrote: ${event.text}`);
    else if (event.kind === "gift") lines.push(`Viewer ${viewerName(event.viewer).slice(0, 30)} sent ${event.count}x ${event.giftName}.`);
  }
  if (plan.kind === "game") lines.push("The host is running a chat quiz game and announcing a round.");
  if (plan.kind === "request") lines.push(`The channel owner asked the host: ${plan.note ?? ""}`);
  if (said.length) lines.push(`The host just said: ${said.slice(-2).join(" ")}`);
  return lines.join("\n");
}

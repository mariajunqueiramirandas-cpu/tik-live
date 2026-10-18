import Anthropic from "@anthropic-ai/sdk";
import { wellFormedDeep, type Effect, type MusicTrack, type Persona, type SafetySettings } from "@tik-live/shared";
import type { Logger } from "../../log";
import { THINKING_OFF_MODELS } from "../safety/gate";
import type { UsageReport } from "../usage";
import { PLAY_MUSIC_TOOL, PLAY_MUSIC_TOOL_NAME, readMusicCall } from "./music-tool";
import { buildSystemPrompt, displayName, reactionSentences, type BriefLayout, type TurnRequest } from "./prompt";
import { effectTags, SentenceSplitter, toUtterance, type Emotion, type Utterance } from "./sentences";

/** Things the host can do besides talking. */
export interface HostActions {
  /** The host composed a piece of music (validated). */
  playMusic?(track: MusicTrack): void;
}

/** How big the conversation is and how much of it came from the prompt cache, over recent turns. */
export interface ContextStats {
  /** Input tokens of the last turn (cached and fresh). */
  tokens: number;
  /** Share of recent turns' input read from the cache, 0-100. */
  cachedPct: number;
}

/** Produces what the host says next, one sentence at a time, as fast as possible. */
export interface HostBrain {
  readonly name: string;
  generate(turn: TurnRequest, signal: AbortSignal, actions?: HostActions): AsyncGenerator<Utterance>;
  /** `speechLanguage: null` lifts a previous voice's language. */
  reconfigure(update: { persona?: Persona; safety?: SafetySettings; speechLanguage?: string | null }): void;
  /** Prompt cache health, for the studio. */
  contextStats?(): ContextStats | null;
  /** Bytes every request carries besides the conversation (system prompt, tools), for the request size budget. */
  requestOverheadBytes?(): number;
}

/** Longest reply when chat is busy (the brief asks for one or two sentences). */
const BRIEF_SENTENCES = 2;

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). Not Haiku 5.5: it has none. */
const FALLBACK_CAPABLE = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

/** Models that take `role: "system"` messages mid-conversation, where the director's brief goes. */
const SYSTEM_MESSAGE_MODELS = new Set([
  "claude-haiku-5-5",
  "claude-sonnet-5-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-fable-5",
  "claude-fable-5-1",
  "claude-mythos-5",
  "claude-mythos-5-1",
]);

/** Turns the cache hit rate is averaged over. */
const CACHE_WINDOW = 20;
/** Rough characters per output token, to meter a reply cut off before the API reported its usage. */
const CHARS_PER_TOKEN = 3;

export interface ClaudeHostOptions {
  client: Anthropic;
  persona: Persona;
  safety: SafetySettings;
  /** The only language the voice speaks, if it has one (BCP 47). */
  speechLanguage?: string;
  model: string;
  effort: "low" | "medium" | "high";
  /** "off" skips thinking for a faster first word, where the model allows it (THINKING_OFF_MODELS). */
  thinking?: "adaptive" | "off";
  onUsage?: (usage: UsageReport) => void;
  log?: Logger;
}

/**
 * The host's brain on Claude (ADR-0026). The show is one conversation: a
 * cached system prompt (persona and rules) and tools, then every turn so far
 * as room → director's brief → reply, then this turn's room and brief. Old
 * turns never change, so each request reads everything before the new room
 * from the prompt cache. Text is streamed and cut into sentences so speech
 * starts before the reply is done.
 */
export class ClaudeHost implements HostBrain {
  readonly name: string;
  private system: string;
  private layout: BriefLayout;
  private readonly recent: Array<{ total: number; cached: number }> = [];

  constructor(private readonly options: ClaudeHostOptions) {
    this.name = options.model;
    this.layout = SYSTEM_MESSAGE_MODELS.has(options.model) ? "system" : "inline";
    this.system = this.buildSystem();
    if (options.thinking === "off" && !THINKING_OFF_MODELS.has(options.model)) {
      options.log?.warn(`${options.model} can't turn thinking off; it keeps adaptive thinking`);
    }
  }

  reconfigure(update: { persona?: Persona; safety?: SafetySettings; speechLanguage?: string | null }): void {
    if (update.persona) this.options.persona = update.persona;
    if (update.safety) this.options.safety = update.safety;
    if (update.speechLanguage === null) delete this.options.speechLanguage;
    else if (update.speechLanguage) this.options.speechLanguage = update.speechLanguage;
    this.system = this.buildSystem();
  }

  contextStats(): ContextStats | null {
    const last = this.recent.at(-1);
    if (!last) return null;
    const total = this.recent.reduce((sum, turn) => sum + turn.total, 0);
    const cached = this.recent.reduce((sum, turn) => sum + turn.cached, 0);
    return { tokens: last.total, cachedPct: total ? Math.round((cached / total) * 100) : 0 };
  }

  async *generate(turn: TurnRequest, signal: AbortSignal, actions: HostActions = {}): AsyncGenerator<Utterance> {
    const { log } = this.options;
    for (let attempt = 0; ; attempt++) {
      let spoke = false;
      try {
        for await (const utterance of this.attempt(turn, signal, actions)) {
          spoke = true;
          yield utterance;
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        if (!spoke && attempt === 0 && this.layout === "system" && err instanceof Anthropic.BadRequestError && /role\W{0,3}system/i.test(err.message)) {
          // A model we thought took mid-conversation system messages doesn't: move the brief into the user turn.
          log?.warn(`${this.options.model} doesn't take the director's brief as a system message; sending it in the user turn`);
          this.layout = "inline";
          this.system = this.buildSystem();
          continue;
        }
        if (err instanceof Anthropic.RateLimitError) log?.warn("rate limited by the Claude API");
        else if (err instanceof Anthropic.APIConnectionError) log?.warn("could not reach the Claude API");
        else if (err instanceof Anthropic.APIError) log?.error(`Claude API error ${err.status}`, err.message);
        else log?.error("host generation failed", err);
        throw err;
      }
    }
  }

  requestOverheadBytes(): number {
    const music = this.options.persona.sound?.music !== false;
    return Buffer.byteLength(JSON.stringify({ system: this.system, ...(music ? { tools: [PLAY_MUSIC_TOOL] } : {}) }));
  }

  private buildSystem(): string {
    return buildSystemPrompt(this.options.persona, this.options.safety, this.options.speechLanguage, this.layout);
  }

  /** The conversation as Messages API turns, with cache breakpoints on the system prompt and the newest room. */
  private messages(turn: TurnRequest): Anthropic.Beta.BetaMessageParam[] {
    const { head, history, room, brief } = turn.context;
    const inline = this.layout === "inline";
    const user = (text: string, briefText: string, first: boolean, last: boolean): Anthropic.Beta.BetaTextBlockParam[] => {
      const blocks: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: first && head ? `${head}\n\n${text}` : text }];
      if (inline) blocks.push({ type: "text", text: `<director>\n${briefText}\n</director>` });
      if (last) (blocks.at(-1) as Anthropic.Beta.BetaTextBlockParam).cache_control = { type: "ephemeral" };
      return blocks;
    };
    const out: Anthropic.Beta.BetaMessageParam[] = [];
    history.forEach((exchange, i) => {
      out.push({ role: "user", content: user(exchange.room, exchange.brief, i === 0, false) });
      if (!inline) out.push({ role: "system", content: exchange.brief });
      out.push({ role: "assistant", content: exchange.reply });
    });
    out.push({ role: "user", content: user(room, brief, history.length === 0, true) });
    if (!inline) out.push({ role: "system", content: brief });
    return out;
  }

  private async *attempt(turn: TurnRequest, signal: AbortSignal, actions: HostActions): AsyncGenerator<Utterance> {
    const { client, model, effort, persona, log } = this.options;
    const thinkingOff = this.options.thinking === "off" && THINKING_OFF_MODELS.has(model);
    // Stable per persona, so the cached prefix (tools, then system) survives across turns.
    const music = persona.sound?.music !== false;
    const local = new AbortController();
    const abort = () => local.abort();
    signal.addEventListener("abort", abort, { once: true });

    // One unpaired half of an emoji anywhere (a viewer's text, a clipped name) and the API refuses the whole request.
    const stream = client.beta.messages.stream(
      wellFormedDeep({
        model,
        max_tokens: 4000,
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        ...(music ? { tools: [PLAY_MUSIC_TOOL], tool_choice: { type: "auto" as const } } : {}),
        output_config: { effort },
        ...(thinkingOff ? { thinking: { type: "disabled" as const } } : {}),
        messages: this.messages(turn),
        ...(FALLBACK_CAPABLE.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      }),
      { signal: local.signal },
    );

    const splitter = new SentenceSplitter();
    const maxUtterances = turn.brief ? BRIEF_SENTENCES : sentenceCap(turn, persona.maxSentences);
    let emotion: Emotion = "neutral";
    let produced = 0;
    // Metered from the stream itself, so a reply cut off mid-way is still counted. The API reports
    // input usage when the message starts but output only when it ends: until then, estimate it.
    let usage: { model: string; input: number; cacheRead: number; cacheWrite: number; output: number } | null = null;
    let streamed = 0;
    let finished = false;
    let reported = false;
    const report = () => {
      if (!usage || reported) return;
      reported = true;
      if (!finished) usage.output = Math.max(usage.output, Math.ceil(streamed / CHARS_PER_TOKEN));
      this.recent.push({ total: usage.input + usage.cacheRead + usage.cacheWrite, cached: usage.cacheRead });
      if (this.recent.length > CACHE_WINDOW) this.recent.shift();
      this.options.onUsage?.({
        kind: "turn",
        model: usage.model,
        inputTokens: usage.input,
        cacheReadTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
      });
    };

    // Effect tags that arrived on their own ("... gift! " then "[confetti]") ride on the next line.
    let orphanFx: Effect[] = [];
    const take = function* (sentences: string[]) {
      for (const sentence of sentences) {
        const utterance = toUtterance(sentence, emotion);
        if (!utterance) {
          orphanFx = [...orphanFx, ...effectTags(sentence)].slice(0, 2);
          continue;
        }
        if (orphanFx.length) {
          utterance.fx = [...new Set([...orphanFx, ...(utterance.fx ?? [])])].slice(0, 2);
          orphanFx = [];
        }
        emotion = utterance.emotion;
        produced += 1;
        yield utterance;
      }
    };

    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          const u = event.message.usage;
          usage = {
            model: event.message.model ?? model,
            input: u.input_tokens,
            cacheRead: u.cache_read_input_tokens ?? 0,
            cacheWrite: u.cache_creation_input_tokens ?? 0,
            output: u.output_tokens,
          };
        } else if (event.type === "message_delta" && usage) {
          usage.output = event.usage.output_tokens;
        } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
          streamed += event.delta.thinking.length;
        } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
          streamed += event.delta.partial_json.length;
        } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          streamed += event.delta.text.length;
          yield* take(splitter.push(event.delta.text));
          if (produced >= maxUtterances) {
            local.abort(); // the model is rambling; cut it off
            return;
          }
        }
      }
      yield* take(splitter.flush());

      const final = await stream.finalMessage();
      finished = true;
      usage = {
        model: final.model ?? model,
        input: final.usage.input_tokens,
        cacheRead: final.usage.cache_read_input_tokens ?? 0,
        cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
        output: final.usage.output_tokens,
      };
      if (final.stop_reason === "refusal") log?.warn("host turn ended in a refusal");
      for (const block of final.content) {
        if (block.type !== "tool_use" || block.name !== PLAY_MUSIC_TOOL_NAME) continue;
        if (final.stop_reason === "max_tokens") {
          log?.warn("the host's music was cut off; not playing it");
          continue;
        }
        const call = readMusicCall(block.input);
        if (call.ok) actions.playMusic?.(call.track);
        else log?.warn(`the host wrote music that doesn't parse (${call.error})`);
      }
    } catch (err) {
      if (local.signal.aborted) return;
      throw err;
    } finally {
      report();
      signal.removeEventListener("abort", abort);
    }
  }
}

/** Where a reply is cut off: one sentence past what the brief asked for. */
function sentenceCap(turn: TurnRequest, maxSentences: number): number {
  // A game turn reads a question and its options, so it gets a little more room.
  if (turn.kind === "game") return maxSentences + 3;
  const chat = turn.items.filter((item) => item.event.kind === "chat" || item.event.kind === "question").length;
  // An answer to chat is kept as short as the brief asked: people are waiting on it.
  if (turn.kind === "react" && chat) return reactionSentences(chat, turn.items.length - chat, maxSentences) + 1;
  return maxSentences + 1;
}

/**
 * A canned, offline host. Lets the whole pipeline (stage, voice, director)
 * run without any API key, and is used by tests and test-mode channels on
 * servers without Claude credentials.
 */
export class ScriptedHost implements HostBrain {
  readonly name = "scripted";
  private fillerIndex = 0;

  constructor(private persona: Persona) {}

  reconfigure(update: { persona?: Persona }): void {
    if (update.persona) this.persona = update.persona;
  }

  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    for (const line of this.lines(turn)) {
      const utterance = toUtterance(line);
      if (utterance) yield utterance;
    }
  }

  private lines(turn: TurnRequest): string[] {
    const name = (item: TurnRequest["items"][number]) => ("viewer" in item.event ? displayName(item.event.viewer, []) : "visitante");
    switch (turn.kind) {
      case "opening":
        return [`[excited] ${this.persona.catchphrases[0] ?? "Oi, gente!"} ${this.persona.name} está no ar!`, `[happy] Bem-vindos ao ${turn.segment.title}.`];
      case "segment_change":
        return [`[excited] Hora de quadro novo: ${turn.nextSegment?.title ?? "uma novidade"}!`];
      case "milestone":
        return [`[excited] ${turn.line ?? "Conseguimos"}! Vocês são demais.`];
      case "game":
        return [`[excited] ${turn.line ?? "Hora do jogo!"}`];
      case "request":
        return ["[happy] Pode deixar, já vai!"];
      case "show":
        return [`[excited] Que chat animado! Bora seguir com ${turn.segment.title}.`];
      case "filler": {
        const fillers = [
          "[thinking] Pergunta rápida pro chat: o que vocês comeram hoje?",
          "[mischief] Tenho uma teoria de que os patos estão secretamente no comando.",
          `[happy] Se você acabou de chegar, oi! Eu sou ${this.persona.name}, uma IA, e esse é o meu programa.`,
          "[surprised] Pera, já é essa hora? O tempo aqui dentro é estranho.",
        ];
        return [fillers[this.fillerIndex++ % fillers.length] as string];
      }
      case "react": {
        const out: string[] = [];
        for (const item of turn.items.slice(0, turn.brief ? 2 : 3)) {
          const e = item.event;
          if (e.kind === "gift") out.push(`[excited] ${name(item)}, obrigado pelo ${e.count}x ${e.giftName}!`);
          else if (e.kind === "follow") out.push(`[love] Valeu por seguir, ${name(item)}!`);
          else if (e.kind === "share") out.push(`[love] ${name(item)} compartilhou a live, que lenda!`);
          else if (e.kind === "join") out.push(`[happy] Que bom te ver de novo, ${name(item)}!`);
          else if (e.kind === "chat" || e.kind === "question") out.push(`[thinking] ${name(item)}, boa! Vou pensar nessa.`);
        }
        return out;
      }
    }
  }
}

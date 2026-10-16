import Anthropic from "@anthropic-ai/sdk";
import type { Persona } from "../config.js";
import { createLogger } from "../log.js";
import type { ViewerMemory } from "./memory.js";
import { buildSystemPrompt, buildTurnMessage, type TurnRequest } from "./prompt.js";
import { SentenceSplitter, toUtterance, type Emotion, type Utterance } from "./sentences.js";

const log = createLogger("host");

/** Produces what the host says next, one sentence at a time, as fast as possible. */
export interface HostBrain {
  readonly name: string;
  generate(turn: TurnRequest, signal: AbortSignal): AsyncGenerator<Utterance>;
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const FALLBACK_CAPABLE = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface ClaudeHostOptions {
  client: Anthropic;
  persona: Persona;
  memory: ViewerMemory;
  blocklist: readonly string[];
  model: string;
  effort: "low" | "medium" | "high";
}

/**
 * The host's brain on Claude. Each turn is a single stateless request: a
 * cached system prompt with the persona and rules, plus one user message with
 * the stream state, the host's recent lines and the live events. Text is
 * streamed and cut into sentences so speech starts before the reply is done.
 */
export class ClaudeHost implements HostBrain {
  readonly name = "claude";
  private readonly system: string;

  constructor(private readonly options: ClaudeHostOptions) {
    this.system = buildSystemPrompt(options.persona);
  }

  async *generate(turn: TurnRequest, signal: AbortSignal): AsyncGenerator<Utterance> {
    const { client, model, effort, persona, memory, blocklist } = this.options;
    const local = new AbortController();
    const abort = () => local.abort();
    signal.addEventListener("abort", abort, { once: true });

    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: 4000,
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        output_config: { effort },
        messages: [{ role: "user", content: buildTurnMessage(turn, memory, blocklist) }],
        ...(FALLBACK_CAPABLE.has(model)
          ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
          : {}),
      },
      { signal: local.signal },
    );

    const splitter = new SentenceSplitter();
    const maxUtterances = persona.maxSentences + 1;
    let emotion: Emotion = "neutral";
    let produced = 0;

    const take = function* (sentences: string[]) {
      for (const sentence of sentences) {
        const utterance = toUtterance(sentence, emotion);
        if (!utterance) continue;
        emotion = utterance.emotion;
        produced += 1;
        yield utterance;
      }
    };

    try {
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield* take(splitter.push(event.delta.text));
          if (produced >= maxUtterances) {
            local.abort(); // the model is rambling; cut it off
            return;
          }
        }
      }
      yield* take(splitter.flush());

      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") log.warn("host turn ended in a refusal");
      log.debug("turn usage", {
        input: final.usage.input_tokens,
        cacheRead: final.usage.cache_read_input_tokens,
        output: final.usage.output_tokens,
      });
    } catch (err) {
      if (local.signal.aborted) return;
      if (err instanceof Anthropic.RateLimitError) {
        log.warn("rate limited by the Claude API");
      } else if (err instanceof Anthropic.APIConnectionError) {
        log.warn("could not reach the Claude API");
      } else if (err instanceof Anthropic.APIError) {
        log.error(`Claude API error ${err.status}`, err.message);
      } else {
        log.error("host generation failed", err);
      }
      throw err;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
}

/**
 * A canned, offline host. Lets you run the whole pipeline (stage, voice,
 * director, OBS) without any API key, and is used by tests.
 */
export class ScriptedHost implements HostBrain {
  readonly name = "scripted";
  private fillerIndex = 0;

  constructor(private readonly persona: Persona) {}

  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    for (const line of this.lines(turn)) {
      const utterance = toUtterance(line);
      if (utterance) yield utterance;
    }
  }

  private lines(turn: TurnRequest): string[] {
    const name = (item: TurnRequest["items"][number]) =>
      "viewer" in item.event ? item.event.viewer.nickname || item.event.viewer.handle : "friend";
    switch (turn.kind) {
      case "opening":
        return [`[excited] ${this.persona.catchphrases[0] ?? "Hello!"} ${this.persona.name} is on air!`, `[happy] Welcome to ${turn.segment.title}.`];
      case "segment_change":
        return [`[excited] New segment time: ${turn.nextSegment?.title ?? "something new"}!`];
      case "milestone":
        return [`[excited] ${turn.note ?? "We did it"}! You are all amazing.`];
      case "filler": {
        const fillers = [
          "[thinking] Quick question for chat: what did you eat today?",
          "[mischief] I have a theory that ducks are secretly in charge.",
          "[happy] If you just got here, hi! I'm an AI orb and this is my show.",
          "[surprised] Wait, is it already this late? Time is weird in here.",
        ];
        return [fillers[this.fillerIndex++ % fillers.length] as string];
      }
      case "react": {
        const out: string[] = [];
        for (const item of turn.items.slice(0, 3)) {
          const e = item.event;
          if (e.kind === "gift") out.push(`[excited] ${name(item)}, thank you for the ${e.count} ${e.giftName}!`);
          else if (e.kind === "follow") out.push(`[love] Thanks for the follow, ${name(item)}!`);
          else if (e.kind === "share") out.push(`[love] ${name(item)} shared the stream, legend!`);
          else if (e.kind === "join") out.push(`[happy] Welcome back, ${name(item)}!`);
          else if (e.kind === "chat" || e.kind === "question") out.push(`[thinking] ${name(item)}, great point. I'll think about that one.`);
        }
        return out;
      }
    }
  }
}

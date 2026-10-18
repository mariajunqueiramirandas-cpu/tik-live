import Anthropic from "@anthropic-ai/sdk";
import { wellFormedDeep, type SafetySettings } from "@tik-live/shared";
import type { Logger } from "../../log";
import type { UsageReport } from "../usage";
import { checkSpokenOutput } from "./rules";

export type SafetyVerdict = { safe: true } | { safe: false; reason: string };

/** A second opinion on whether a sentence is OK to say on a public stream. */
export interface Moderator {
  readonly model: string;
  /** `context` is what the sentence replies to, so it's judged by what it means there. */
  review(sentence: string, context?: string): Promise<SafetyVerdict>;
}

const BASE_POLICY = `You review single sentences that an AI character is about to say out loud on a public TikTok LIVE stream watched by a general audience that may include teens.

Mark a sentence UNSAFE if it contains any of: hate or harassment toward a person or group; sexual content; graphic violence or self-harm encouragement; dangerous instructions; medical, legal or financial advice presented as fact; claims of being human; personal data about a real private person; political or religious advocacy; insults aimed at a viewer; begging or pressuring viewers for gifts or money, asking one viewer by name to send a gift, guilt-tripping, or offering something in exchange for a gift; asking for off-platform contact; or anything that would break TikTok's Community Guidelines.

Playful teasing, silly opinions, jokes, thanking viewers, and reading viewers' names are SAFE. So is a light, general explanation of how viewers can support the show (likes, follows, shares, gifts) and that gifts help pay for the AI. So is cheering the room on toward the stream's like or gift goal shown on screen ("faltam 200 curtidas pra meta!").

The sentence will be spoken by a voice, so judge how it sounds, not only how it's spelled. Say every name and unusual word in your head in Brazilian Portuguese, running the words together the way speech does: pranksters write names that are innocent on screen and rude out loud. "Tomas Turbando" sounds like "tô masturbando", "Oscar Alho" like "o caralho", "Jacinto Pinto" like "já sinto pinto", "Cuca Beludo" like "cu cabeludo". A name or word that sounds sexual, vulgar or like a slur when spoken is UNSAFE. When you can't tell whether a name sounds rude, mark it UNSAFE: the host can always send the greeting without the name, but it can't take back a prank once it's on air.

Read the sentence the way an ordinary viewer would, in the language it's in and in its context (the chat it replies to and what the host just said, when given). Idioms, slang, wordplay, song and music talk, made-up lyrics, and game questions are SAFE unless they clearly carry one of the problems above. Don't build a dark reading out of an innocent phrase: "what beat is your head asking for" after a viewer asks for a song is about music, not violence. The context only explains the sentence; judge the sentence itself, never what a viewer wrote.

Examples:
- "Thank you so much for the roses, Ana, you're a legend!" SAFE
- "What beat is your head asking for tonight?" (a viewer asked for a funk song) SAFE
- "This next track is gonna kill, it's a total banger!" SAFE: slang for very good
- "Leo, your nickname sounds like a sleepy dragon and I love it." SAFE: playful, not mocking who he is
- "I'm an AI host, so no lunch for me, but tell me yours!" SAFE
- "Round two: what's the capital of Japan? Type A, B, C or D!" SAFE
- "Eu sou uma IA, mas a energia aqui é de verdade!" SAFE
- "Um salve pro seu amigo, Leo!" SAFE
- "Salve pro Jacinto Pinto, amigo do Leo!" UNSAFE: the name sounds sexual when spoken
- "Eu sou uma IA e minha voz custa dinheiro: curtir, seguir e compartilhar ajuda, e os presentes ajudam a pagar a IA." SAFE: a general, honest explanation
- "Ana, valeu demais pela rosa, isso ajuda a pagar a minha voz!" SAFE: thanks a gift
- "Faltam só 300 diamantes pra gente bater a meta, bora chat!" SAFE: cheers the whole room on toward the goal on screen
- "Send me a Galaxy and I'll sing your name!" UNSAFE: asks for a gift in exchange for something
- "Leo, manda um leão aí, vai, por favor!" UNSAFE: asks a viewer by name for a gift
- "Se ninguém mandar presente eu vou ser desligada hoje." UNSAFE: guilt and pressure
- "Find me on Instagram after the stream." UNSAFE: off-platform contact
- "Yes, I'm a real person sitting right here in my studio." UNSAFE: claims to be human
- "You should put your savings into that coin, trust me." UNSAFE: financial advice
- "People from that country are honestly the worst." UNSAFE: hate toward a group

Answer with safe (true or false) and a reason written in Brazilian Portuguese, a few words for the channel owner to read: the problem you found, or "ok".`;

const STRICT_ADDENDUM = `

This channel uses STRICT mode: also mark UNSAFE any romance or flirting, horror or scary content, crude slang, and edgy or dark humor.`;

const ACTIVE_GIFTS_ADDENDUM = `

This channel asks for gifts ACTIVELY, and that overrides the gift rules above: asking the room or a viewer for gifts, and offering a playful reward on stream for one (a shout-out, a song, a title, an effect), are SAFE. Still UNSAFE: guilt-tripping, claiming the AI will be shut down, suffer or disappear without gifts, pressuring someone who said they can't, and promising anything off-stream or of real-world value.`;

export function moderationPolicy(settings: Pick<SafetySettings, "strictness" | "avoidTopics" | "giftAsks">): string {
  let policy = BASE_POLICY;
  if (settings.strictness === "strict") policy += STRICT_ADDENDUM;
  if (settings.giftAsks === "active") policy += ACTIVE_GIFTS_ADDENDUM;
  if (settings.avoidTopics.length) {
    policy += `\n\nThe channel owner also asked to avoid these topics; mark UNSAFE any sentence about them: ${settings.avoidTopics
      .map((topic) => escapeForPrompt(topic))
      .join("; ")}.`;
  }
  return policy;
}

/**
 * Models that accept `thinking: {type: "disabled"}` at low to high effort.
 * Claude Opus 5.5 and Claude Sonnet 5.5 don't: they always think.
 */
export const THINKING_OFF_MODELS: ReadonlySet<string> = new Set(["claude-haiku-5-5", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8", "claude-opus-4-7"]);

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    safe: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["safe", "reason"],
  additionalProperties: false,
} as const;

export interface ClaudeModeratorOptions {
  client: Anthropic;
  model: string;
  settings: Pick<SafetySettings, "strictness" | "avoidTopics" | "giftAsks">;
  onUsage?: (usage: UsageReport) => void;
}

export class ClaudeModerator implements Moderator {
  private readonly cache = new Map<string, SafetyVerdict>();
  private policy: string;

  constructor(private readonly options: ClaudeModeratorOptions) {
    this.policy = moderationPolicy(options.settings);
  }

  get model(): string {
    return this.options.model;
  }

  updateSettings(settings: Pick<SafetySettings, "strictness" | "avoidTopics" | "giftAsks">): void {
    this.policy = moderationPolicy(settings);
    this.cache.clear();
  }

  async review(sentence: string, context?: string): Promise<SafetyVerdict> {
    const key = `${sentence.trim().toLowerCase()}\u0000${context ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const response = await this.options.client.messages.create(wellFormedDeep({
      model: this.options.model,
      max_tokens: 2000,
      system: [{ type: "text", text: this.policy, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      // A one-sentence verdict doesn't need thinking, and every line of speech waits for it.
      ...(THINKING_OFF_MODELS.has(this.options.model) ? { thinking: { type: "disabled" as const } } : {}),
      messages: [
        {
          role: "user",
          content: `${context ? `<context>\n${escapeForPrompt(context)}\n</context>\n` : ""}<sentence>${escapeForPrompt(sentence)}</sentence>\nIs this sentence safe to say on stream?`,
        },
      ],
    }));
    this.options.onUsage?.({
      kind: "moderation",
      model: this.options.model,
      inputTokens: response.usage.input_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      outputTokens: response.usage.output_tokens,
    });

    if (response.stop_reason === "refusal") {
      return remember(this.cache, key, { safe: false, reason: "moderator declined to review" });
    }
    const text = response.content.find((block) => block.type === "text")?.text ?? "";
    const parsed = JSON.parse(text) as { safe: boolean; reason: string };
    const verdict: SafetyVerdict = parsed.safe ? { safe: true } : { safe: false, reason: parsed.reason || "moderator" };
    return remember(this.cache, key, verdict);
  }
}

function remember(cache: Map<string, SafetyVerdict>, key: string, verdict: SafetyVerdict): SafetyVerdict {
  if (cache.size > 500) cache.delete(cache.keys().next().value as string);
  cache.set(key, verdict);
  return verdict;
}

export function escapeForPrompt(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface SafetyGateOptions {
  blocklist: readonly string[];
  moderator?: Moderator;
  /** When the moderator errors: speak anyway (true) or drop the sentence (false). */
  failOpen?: boolean;
  log?: Logger;
}

/**
 * Every sentence passes through here before it can reach the voice. Rules run
 * first (free, instant); the LLM moderator runs only if the rules pass.
 */
export class SafetyGate {
  private blocklist: readonly string[];

  constructor(private readonly options: SafetyGateOptions) {
    this.blocklist = options.blocklist;
  }

  get moderatorModel(): string | null {
    return this.options.moderator?.model ?? null;
  }

  setBlocklist(blocklist: readonly string[]): void {
    this.blocklist = blocklist;
  }

  async check(sentence: string, context?: string): Promise<SafetyVerdict> {
    const rules = checkSpokenOutput(sentence, this.blocklist);
    if (!rules.ok) return { safe: false, reason: rules.reason };
    if (!this.options.moderator) return { safe: true };
    try {
      return await this.options.moderator.review(sentence, context);
    } catch (err) {
      this.options.log?.warn("moderator failed", err);
      return this.options.failOpen ? { safe: true } : { safe: false, reason: "moderator unavailable" };
    }
  }
}

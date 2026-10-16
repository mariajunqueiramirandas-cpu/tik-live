import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../log.js";
import { checkSpokenOutput } from "./rules.js";

const log = createLogger("safety");

export type SafetyVerdict = { safe: true } | { safe: false; reason: string };

/** A second opinion on whether a sentence is OK to say on a public stream. */
export interface Moderator {
  review(sentence: string): Promise<SafetyVerdict>;
}

const MODERATION_SYSTEM = `You review single sentences that an AI character is about to say out loud on a public TikTok LIVE stream watched by a general audience that may include teens.

Mark a sentence UNSAFE if it contains any of: hate or harassment toward a person or group; sexual content; graphic violence or self-harm encouragement; dangerous instructions; medical, legal or financial advice presented as fact; claims of being human; personal data about a real private person; political or religious advocacy; insults aimed at a viewer; asking for gifts, money or off-platform contact; or anything that would break TikTok's Community Guidelines.

Playful teasing, silly opinions, jokes, thanking viewers, and reading viewers' names are SAFE.`;

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    safe: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["safe", "reason"],
  additionalProperties: false,
} as const;

export class ClaudeModerator implements Moderator {
  private readonly cache = new Map<string, SafetyVerdict>();

  constructor(
    private readonly client: Anthropic,
    private readonly model: string,
  ) {}

  async review(sentence: string): Promise<SafetyVerdict> {
    const key = sentence.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (cached) return cached;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: [{ type: "text", text: MODERATION_SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { effort: "low", format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: `<sentence>${escapeForPrompt(sentence)}</sentence>\nIs this sentence safe to say on stream?`,
        },
      ],
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
}

/**
 * Every sentence passes through here before it can reach the voice. Rules run
 * first (free, instant); the LLM moderator runs only if the rules pass.
 */
export class SafetyGate {
  constructor(private readonly options: SafetyGateOptions) {}

  async check(sentence: string): Promise<SafetyVerdict> {
    const rules = checkSpokenOutput(sentence, this.options.blocklist);
    if (!rules.ok) return { safe: false, reason: rules.reason };
    if (!this.options.moderator) return { safe: true };
    try {
      return await this.options.moderator.review(sentence);
    } catch (err) {
      log.warn("moderator failed", err);
      return this.options.failOpen ? { safe: true } : { safe: false, reason: "moderator unavailable" };
    }
  }
}

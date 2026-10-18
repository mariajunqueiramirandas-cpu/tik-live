import { clip } from "@tik-live/shared";
import { escapeForPrompt } from "../safety/gate";
import { cleanTopic } from "./memory";

/** Something the host said about itself, e.g. { topic: "favorite food", fact: "pizza with pineapple" }. */
export interface HostFact {
  topic: string;
  fact: string;
  /** The last time the host said it (it may come up again on later streams). */
  at: number;
}

/** Where a channel's host facts live between streams (Postgres in production). */
export interface HostFactsPersistence {
  save(facts: HostFact[]): Promise<void>;
}

/** The most facts kept per channel; past this the one the host mentioned least recently goes. */
const MAX_FACTS = 24;

export interface HostFactsOptions {
  persistence?: HostFactsPersistence;
  now?: () => number;
}

/**
 * What the host has said about itself on this channel, across streams: its
 * favorite food, its team, its made-up backstory. A host that improvises
 * these forgets them when old turns leave the conversation and on the next
 * stream, and then says something else; viewers notice. So the first thing
 * the host said on a topic stands, the conversation's head reminds it
 * (`render`), and saying it again only keeps it fresh.
 */
export class HostFacts {
  private facts: HostFact[];
  private dirty = false;
  private readonly now: () => number;

  constructor(
    initial: readonly HostFact[] = [],
    private readonly options: HostFactsOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.facts = initial.slice(-MAX_FACTS);
  }

  all(): readonly HostFact[] {
    return this.facts;
  }

  /** Records what the host said about itself. Returns false when it already had a fact on that topic (which then stands). */
  learn(topic: string, fact: string): boolean {
    const key = cleanTopic(topic);
    const text = clip(fact.trim(), 100);
    if (!key || !text) return false;
    const at = this.now();
    const known = this.facts.find((existing) => existing.topic === key);
    this.dirty = true;
    if (known) {
      known.at = at;
      return false;
    }
    this.facts = [...this.facts, { topic: key, fact: text, at }].sort((a, b) => a.at - b.at).slice(-MAX_FACTS);
    return true;
  }

  /** The block the conversation's head carries, or "" when the host hasn't said anything about itself yet. */
  render(): string {
    if (!this.facts.length) return "";
    const lines = [...this.facts].sort((a, b) => a.topic.localeCompare(b.topic)).map((fact) => `- ${fact.topic}: ${fact.fact}`);
    return `<about_you>\nWhat you've already said about yourself on this channel. Viewers remember: keep saying the same.\n${escapeForPrompt(lines.join("\n"))}\n</about_you>`;
  }

  /** Writes the facts if they changed. Failures keep them dirty for the next flush. */
  async flush(): Promise<void> {
    if (!this.dirty || !this.options.persistence) return;
    this.dirty = false;
    try {
      await this.options.persistence.save(this.facts.map((fact) => ({ ...fact })));
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}

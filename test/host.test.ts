import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ClaudeHost } from "../src/brain/host.js";
import { ViewerMemory } from "../src/brain/memory.js";
import type { TurnRequest } from "../src/brain/prompt.js";
import { persona } from "./helpers.js";

/** Just enough of the SDK's stream surface for ClaudeHost: async iteration + finalMessage(). */
function fakeClient(chunks: string[], captured: { params?: Record<string, unknown>; aborted?: boolean }) {
  return {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, options: { signal: AbortSignal }) {
          captured.params = params;
          return {
            async *[Symbol.asyncIterator]() {
              for (const text of chunks) {
                if (options.signal.aborted) {
                  captured.aborted = true;
                  return;
                }
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
              }
            },
            finalMessage: async () => ({
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

const turn: TurnRequest = {
  kind: "filler",
  items: [],
  segment: persona.segments[0]!,
  stats: { viewers: 1, likes: 0, uptimeMinutes: 0 },
  recentLines: [],
};

async function collect(host: ClaudeHost) {
  const out = [];
  for await (const u of host.generate(turn, new AbortController().signal)) out.push(u);
  return out;
}

describe("ClaudeHost", () => {
  it("streams sentences with emotions, and opts into refusal fallbacks", async () => {
    const captured: { params?: Record<string, unknown> } = {};
    const host = new ClaudeHost({
      client: fakeClient(["[happy] Hello every", "one in chat! [thinking] What did you", " eat today?"], captured),
      persona,
      memory: new ViewerMemory(),
      blocklist: [],
      model: "claude-opus-5-5",
      effort: "low",
    });
    expect(await collect(host)).toEqual([
      { text: "Hello everyone in chat!", emotion: "happy" },
      { text: "What did you eat today?", emotion: "thinking" },
    ]);
    expect(captured.params).toMatchObject({
      model: "claude-opus-5-5",
      output_config: { effort: "low" },
      fallbacks: "default",
      betas: ["server-side-fallback-2026-07-01"],
    });
  });

  it("cuts off a rambling reply after maxSentences + 1", async () => {
    const captured: { aborted?: boolean } = {};
    const rambling = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i + 1}. `);
    const host = new ClaudeHost({
      client: fakeClient(rambling, captured),
      persona,
      memory: new ViewerMemory(),
      blocklist: [],
      model: "claude-opus-5-5",
      effort: "low",
    });
    const out = await collect(host);
    expect(out).toHaveLength(persona.maxSentences + 1);
  });

  it("does not send fallbacks to models that don't support them", async () => {
    const captured: { params?: Record<string, unknown> } = {};
    const host = new ClaudeHost({
      client: fakeClient(["Hi there friends."], captured),
      persona,
      memory: new ViewerMemory(),
      blocklist: [],
      model: "claude-haiku-5-5",
      effort: "low",
    });
    await collect(host);
    expect(captured.params).not.toHaveProperty("fallbacks");
  });
});

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "bun:test";
import { ClaudeHost } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import { persona } from "./helpers";

/** Just enough of the SDK's stream surface for ClaudeHost: async iteration + finalMessage(). */
function fakeClient(chunks: string[], captured: { params?: Record<string, unknown>; aborted?: boolean }, content: unknown[] = []) {
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
              content,
              stop_reason: content.length ? "tool_use" : "end_turn",
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
  history: [],
  upcoming: [],
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
      safety: { blocklist: [], strictness: "standard", avoidTopics: [] },
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
      safety: { blocklist: [], strictness: "standard", avoidTopics: [] },
      model: "claude-opus-5-5",
      effort: "low",
    });
    const out = await collect(host);
    expect(out).toHaveLength(persona.maxSentences + 1);
  });

  it("offers the music tool and plays only scores that parse", async () => {
    const played: string[] = [];
    const score = { title: "Tiny beat", bpm: 120, bars: 1, repeat: 2, swing: 0, parts: [{ instrument: "kick", pattern: "x . . . x . . . x . . . x . . .", volume: 0.9 }] };
    const broken = { ...score, title: "Broken", parts: [{ instrument: "kick", pattern: "boom boom", volume: 1 }] };
    const captured: { params?: Record<string, unknown> } = {};
    const host = new ClaudeHost({
      client: fakeClient(["[excited] Here comes a beat! [notes]"], captured, [
        { type: "tool_use", id: "t1", name: "play_music", input: score },
        { type: "tool_use", id: "t2", name: "play_music", input: broken },
      ]),
      persona,
      memory: new ViewerMemory(),
      safety: { blocklist: [], strictness: "standard", avoidTopics: [] },
      model: "claude-opus-5-5",
      effort: "low",
    });
    const out = [];
    for await (const u of host.generate(turn, new AbortController().signal, { playMusic: (track) => played.push(track.title) })) out.push(u);
    expect(out).toEqual([{ text: "Here comes a beat!", emotion: "excited", fx: ["notes"] }]);
    expect(played).toEqual(["Tiny beat"]);
    expect((captured.params?.tools as Array<{ name: string }>)[0]?.name).toBe("play_music");

    const quiet = new ClaudeHost({
      client: fakeClient(["Hi."], captured),
      persona: { ...persona, sound: { music: false, effects: true } },
      memory: new ViewerMemory(),
      safety: { blocklist: [], strictness: "standard", avoidTopics: [] },
      model: "claude-opus-5-5",
      effort: "low",
    });
    for await (const _ of quiet.generate(turn, new AbortController().signal)) void _;
    expect(captured.params).not.toHaveProperty("tools");
  });

  it("does not send fallbacks to models that don't support them", async () => {
    const captured: { params?: Record<string, unknown> } = {};
    const host = new ClaudeHost({
      client: fakeClient(["Hi there friends."], captured),
      persona,
      memory: new ViewerMemory(),
      safety: { blocklist: [], strictness: "standard", avoidTopics: [] },
      model: "claude-haiku-5-5",
      effort: "low",
    });
    await collect(host);
    expect(captured.params).not.toHaveProperty("fallbacks");
  });
});

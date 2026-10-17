import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "bun:test";
import type { TurnContext } from "../../src/runtime/brain/conversation";
import { ClaudeHost } from "../../src/runtime/brain/host";
import type { TurnRequest } from "../../src/runtime/brain/prompt";
import type { UsageReport } from "../../src/runtime/usage";
import { persona } from "./helpers";

interface Captured {
  params?: Record<string, unknown>;
  calls?: number;
  aborted?: boolean;
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };

/** Just enough of the SDK's stream surface for ClaudeHost: async iteration (with usage events) + finalMessage(). */
function fakeClient(
  chunks: string[],
  captured: Captured,
  options: { content?: unknown[]; usage?: Usage; fail?: (params: Record<string, unknown>) => Error | undefined } = {},
) {
  const usage = options.usage ?? { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  return {
    beta: {
      messages: {
        stream(params: Record<string, unknown>, opts: { signal: AbortSignal }) {
          captured.params = params;
          captured.calls = (captured.calls ?? 0) + 1;
          const failure = options.fail?.(params);
          return {
            async *[Symbol.asyncIterator]() {
              if (failure) throw failure;
              yield { type: "message_start", message: { model: params.model, usage: { ...usage, output_tokens: 1 } } };
              for (const text of chunks) {
                if (opts.signal.aborted) {
                  captured.aborted = true;
                  return;
                }
                yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } };
                yield { type: "message_delta", usage: { output_tokens: 2 } };
              }
            },
            finalMessage: async () => ({
              model: params.model,
              content: options.content ?? [],
              stop_reason: options.content?.length ? "tool_use" : "end_turn",
              usage,
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

function context(partial: Partial<TurnContext> = {}): TurnContext {
  return { head: "", history: [], room: "<room>\n(nothing new: chat is quiet)\n</room>", brief: "Now: say hi.", ...partial };
}

function turn(partial: Partial<TurnRequest> = {}): TurnRequest {
  return {
    kind: "filler",
    items: [],
    segment: persona.segments[0]!,
    stats: { viewers: 1, likes: 0, uptimeMinutes: 0 },
    context: context(),
    ...partial,
  };
}

const safety = { blocklist: [], strictness: "standard" as const, avoidTopics: [] };

async function collect(host: ClaudeHost, request = turn()) {
  const out = [];
  for await (const u of host.generate(request, new AbortController().signal)) out.push(u);
  return out;
}

type Message = { role: string; content: string | Array<{ type: string; text: string; cache_control?: unknown }> };

describe("ClaudeHost", () => {
  it("streams sentences with emotions, and opts into refusal fallbacks on models that have them", async () => {
    const captured: Captured = {};
    const host = new ClaudeHost({
      client: fakeClient(["[happy] Hello every", "one in chat! [thinking] What did you", " eat today?"], captured),
      persona,
      safety,
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

  it("sends the show as one cached conversation: rooms, the director's briefs as system messages, and its own replies", async () => {
    const captured: Captured = {};
    const host = new ClaudeHost({ client: fakeClient(["Hi there friends."], captured), persona, safety, model: "claude-haiku-5-5", effort: "low" });
    const request = turn({
      context: context({
        head: "<last_stream>\nAna won trivia.\n</last_stream>",
        history: [
          { room: "<room>r1</room>", brief: "b1", reply: "[happy] Hello!" },
          { room: "<room>r2</room>", brief: "b2", reply: "Welcome back." },
        ],
        room: "<room>r3</room>",
        brief: "b3",
      }),
    });
    await collect(host, request);
    const params = captured.params!;
    // Haiku 5.5: no refusal fallbacks (it has none), no sampling parameters, no prefill.
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("temperature");
    const system = params.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(system[0]?.text).toContain("a system message from the show's director");

    const messages = params.messages as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user", "system", "assistant", "user", "system", "assistant", "user", "system"]);
    const text = (m: Message) => (typeof m.content === "string" ? m.content : m.content.map((block) => block.text).join("|"));
    expect(text(messages[0]!)).toBe("<last_stream>\nAna won trivia.\n</last_stream>\n\n<room>r1</room>");
    expect(messages.map(text).slice(1)).toEqual(["b1", "[happy] Hello!", "<room>r2</room>", "b2", "Welcome back.", "<room>r3</room>", "b3"]);
    expect(messages.at(-1)?.role).toBe("system"); // ends on the brief: never an assistant prefill

    // One breakpoint on the newest room, none on older turns: the next request reads all of this from cache.
    const marked = messages.flatMap((m, i) => (typeof m.content !== "string" && m.content.some((block) => block.cache_control) ? [i] : []));
    expect(marked).toEqual([6]);
  });

  it("keeps the earlier turns byte-identical from one request to the next", async () => {
    const captured: Captured = {};
    const host = new ClaudeHost({ client: fakeClient(["Hi."], captured), persona, safety, model: "claude-haiku-5-5", effort: "low" });
    await collect(host, turn({ context: context({ head: "<earlier>\nx\n</earlier>", room: "<room>r1</room>", brief: "b1" }) }));
    const first = structuredClone(captured.params);
    await collect(host, turn({ context: context({ head: "<earlier>\nx\n</earlier>", history: [{ room: "<room>r1</room>", brief: "b1", reply: "Hi." }], room: "<room>r2</room>", brief: "b2" }) }));
    const second = captured.params!;
    const strip = (value: unknown) => JSON.stringify(value, (key, v) => (key === "cache_control" ? undefined : v));
    expect(strip(second.system)).toBe(strip(first?.system));
    expect(strip(second.tools)).toBe(strip(first?.tools));
    const before = first?.messages as Message[];
    expect(strip((second.messages as Message[]).slice(0, before.length))).toBe(strip(before));
  });

  it("puts the brief in the user turn for models without mid-conversation system messages", async () => {
    const captured: Captured = {};
    const host = new ClaudeHost({ client: fakeClient(["Hi."], captured), persona, safety, model: "claude-sonnet-5", effort: "low" });
    await collect(host, turn({ context: context({ history: [{ room: "<room>r1</room>", brief: "b1", reply: "Hi." }], room: "<room>r2</room>", brief: "b2" }) }));
    const messages = captured.params!.messages as Message[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const last = messages[2]!.content as Array<{ text: string; cache_control?: unknown }>;
    expect(last.map((block) => block.text)).toEqual(["<room>r2</room>", "<director>\nb2\n</director>"]);
    expect(last[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect((captured.params!.system as Array<{ text: string }>)[0]?.text).toContain("<director> block");
  });

  it("falls back to the inline brief when the API refuses system messages", async () => {
    const captured: Captured = {};
    const fail = (params: Record<string, unknown>) =>
      (params.messages as Message[]).some((m) => m.role === "system")
        ? new Anthropic.BadRequestError(
            400,
            { type: "error", error: { type: "invalid_request_error", message: "role 'system' is not supported on this model" } },
            undefined,
            new Headers(),
          )
        : undefined;
    const host = new ClaudeHost({ client: fakeClient(["Still here."], captured, { fail }), persona, safety, model: "claude-haiku-5-5", effort: "low" });
    expect(await collect(host)).toEqual([{ text: "Still here.", emotion: "neutral" }]);
    expect(captured.calls).toBe(2);
    expect((captured.params!.messages as Message[]).map((m) => m.role)).toEqual(["user"]);
    // And it stays there.
    await collect(host);
    expect(captured.calls).toBe(3);
  });

  it("cuts off a rambling reply after maxSentences + 1, and still meters what it used", async () => {
    const captured: Captured = {};
    const usage: UsageReport[] = [];
    const rambling = Array.from({ length: 10 }, (_, i) => `This is sentence number ${i + 1}. `);
    const host = new ClaudeHost({
      client: fakeClient(rambling, captured, { usage: { input_tokens: 40, output_tokens: 9, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 300 } }),
      persona,
      safety,
      model: "claude-haiku-5-5",
      effort: "low",
      onUsage: (u) => usage.push(u),
    });
    const out = await collect(host);
    expect(out).toHaveLength(persona.maxSentences + 1);
    expect(usage).toEqual([{ kind: "turn", model: "claude-haiku-5-5", inputTokens: 40, cacheReadTokens: 2_000, cacheWriteTokens: 300, outputTokens: 2 }]);
    expect(host.contextStats()).toEqual({ tokens: 2_340, cachedPct: 85 });
  });

  it("keeps busy replies to two sentences", async () => {
    const lines = ["Thanks for the roses, Ana! ", "Welcome in, Joe and Bia! ", "Great question about cats. ", "And one more thing here."];
    const host = new ClaudeHost({ client: fakeClient(lines, {}), persona, safety, model: "claude-haiku-5-5", effort: "low" });
    expect(await collect(host, turn({ kind: "react", brief: true }))).toHaveLength(2);
  });

  it("offers the music tool and plays only scores that parse", async () => {
    const played: string[] = [];
    const score = { title: "Tiny beat", bpm: 120, bars: 1, repeat: 2, swing: 0, parts: [{ instrument: "kick", pattern: "x . . . x . . . x . . . x . . .", volume: 0.9 }] };
    const broken = { ...score, title: "Broken", parts: [{ instrument: "kick", pattern: "boom boom", volume: 1 }] };
    const captured: Captured = {};
    const host = new ClaudeHost({
      client: fakeClient(["[excited] Here comes a beat! [notes]"], captured, {
        content: [
          { type: "tool_use", id: "t1", name: "play_music", input: score },
          { type: "tool_use", id: "t2", name: "play_music", input: broken },
        ],
      }),
      persona,
      safety,
      model: "claude-haiku-5-5",
      effort: "low",
    });
    const out = [];
    for await (const u of host.generate(turn(), new AbortController().signal, { playMusic: (track) => played.push(track.title) })) out.push(u);
    expect(out).toEqual([{ text: "Here comes a beat!", emotion: "excited", fx: ["notes"] }]);
    expect(played).toEqual(["Tiny beat"]);
    expect((captured.params?.tools as Array<{ name: string }>)[0]?.name).toBe("play_music");

    const quiet = new ClaudeHost({
      client: fakeClient(["Hi."], captured),
      persona: { ...persona, sound: { music: false, effects: true } },
      safety,
      model: "claude-haiku-5-5",
      effort: "low",
    });
    await collect(quiet);
    expect(captured.params).not.toHaveProperty("tools");
  });
});

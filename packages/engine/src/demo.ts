import type { Emotion, Look, StageServerPayload } from "@tik-live/shared";
import type { StageEngine } from "./engine";

/**
 * A scripted show for places with no server behind them: the landing page
 * hero and the character editor. Lines play through the same engine path as
 * a real stream (captions, mouth, alerts), with text-derived mouth movement
 * instead of audio.
 */
export type DemoBeat =
  | { kind: "say"; text: string; emotion: Emotion }
  | { kind: "gift"; name: string; giftName: string; count?: number; diamonds: number }
  | { kind: "follow"; name: string }
  | { kind: "share"; name: string }
  | { kind: "segment"; title: string }
  | { kind: "pause"; ms: number };

export interface DemoOptions {
  name?: string;
  look?: Look;
  script?: readonly DemoBeat[];
  loop?: boolean;
  /** Called before each beat (the landing page mirrors chat next to the stage). */
  onBeat?: (beat: DemoBeat, index: number) => void;
}

export interface DemoHandle {
  stop(): void;
}

export const DEMO_SCRIPT: readonly DemoBeat[] = [
  { kind: "segment", title: "Ask me anything" },
  { kind: "pause", ms: 900 },
  { kind: "say", text: "Hi, I'm Blip. I'm an AI host and I'm live right now, so say hi.", emotion: "happy" },
  { kind: "pause", ms: 700 },
  { kind: "say", text: "Lua wants to know if I ever sleep. I don't, but I do dim a little around four in the morning.", emotion: "mischief" },
  { kind: "follow", name: "lua.draws" },
  { kind: "pause", ms: 600 },
  { kind: "say", text: "Lua, thank you for the follow. Welcome to the deep end.", emotion: "love" },
  { kind: "pause", ms: 500 },
  { kind: "gift", name: "theo_k", giftName: "Rose", count: 5, diamonds: 5 },
  { kind: "say", text: "Five roses from Theo! I'm putting them in the reef where everyone can see.", emotion: "excited" },
  { kind: "pause", ms: 700 },
  { kind: "say", text: "Okay, real question for chat. Pineapple on pizza, yes or no?", emotion: "thinking" },
  { kind: "pause", ms: 900 },
  { kind: "share", name: "marina.v" },
  { kind: "say", text: "Marina shared the stream. Hello to everyone Marina brought along!", emotion: "laugh" },
  { kind: "pause", ms: 600 },
  { kind: "gift", name: "duda", giftName: "Galaxy", diamonds: 1000 },
  { kind: "say", text: "Duda, a whole galaxy? I don't even know what to say. Okay, I do. Thank you!", emotion: "surprised" },
  { kind: "pause", ms: 1400 },
];

/** Speaking time for a line, roughly 2.7 words a second plus a breath. */
export function estimateLineMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.round(500 + words * 370);
}

export function startDemo(engine: StageEngine, options: DemoOptions = {}): DemoHandle {
  const script = options.script ?? DEMO_SCRIPT;
  const loop = options.loop ?? true;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let wake: (() => void) | null = null;
  let cue = 0;

  if (options.look) engine.setLook(options.name ?? "Blip", options.look);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = resolve;
      timer = setTimeout(resolve, ms);
    });

  const apply = (message: StageServerPayload) => {
    if (!stopped) engine.apply(message);
  };

  const run = async () => {
    do {
      for (let i = 0; i < script.length && !stopped; i++) {
        const beat = script[i] as DemoBeat;
        options.onBeat?.(beat, i);
        switch (beat.kind) {
          case "say": {
            const id = `demo-${++cue}`;
            const durationMs = estimateLineMs(beat.text);
            // Preview engines don't report `spoken`, so wait on the clock;
            // finishing early (demo mode) just moves on sooner.
            const spoken = new Promise<void>((resolve) => {
              const off = engine.on("spoken", (done) => {
                if (done === id) {
                  off();
                  resolve();
                }
              });
              setTimeout(() => {
                off();
                resolve();
              }, durationMs + 400);
            });
            apply({ t: "speak", id, text: beat.text, emotion: beat.emotion, audioUrl: null, durationMs });
            await spoken;
            await sleep(450);
            break;
          }
          case "gift":
            apply({ t: "alert", kind: "gift", name: beat.name, giftName: beat.giftName, count: beat.count ?? 1, diamonds: beat.diamonds });
            await sleep(1200);
            break;
          case "follow":
          case "share":
            apply({ t: "alert", kind: beat.kind, name: beat.name });
            await sleep(900);
            break;
          case "segment":
            apply({ t: "segment", title: beat.title });
            break;
          case "pause":
            await sleep(beat.ms);
            break;
        }
      }
    } while (loop && !stopped);
  };
  void run();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
      engine.apply({ t: "stop" });
    },
  };
}

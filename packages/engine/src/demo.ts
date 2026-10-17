import type { Effect, Emotion, GameScene, Look, StageServerPayload } from "@tik-live/shared";
import type { StageEngine } from "./engine";

/**
 * A scripted show for places with no server behind them: the landing page
 * hero and the character editor. Lines play through the same engine path as
 * a real stream (captions, mouth, alerts), with text-derived mouth movement
 * instead of audio.
 */
export type DemoBeat =
  /** A viewer's chat message: the page shows it; the engine has nothing to draw. */
  | { kind: "chat"; name: string; text: string }
  | { kind: "say"; text: string; emotion: Emotion }
  | { kind: "gift"; name: string; giftName: string; count?: number; diamonds: number }
  | { kind: "follow"; name: string }
  | { kind: "share"; name: string }
  | { kind: "segment"; title: string }
  /** A game scene on stage, or null to go back to the show. */
  | { kind: "game"; scene: GameScene | null }
  /** A reaction (confetti, a spin...). */
  | { kind: "fx"; fx: Effect; intensity?: number }
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
  { kind: "segment", title: "Pode perguntar" },
  { kind: "pause", ms: 700 },
  { kind: "chat", name: "mari.souza", text: "oiii" },
  { kind: "say", text: "Oi, Mari! Eu sou o Blip, um apresentador de IA, e tô ao vivo agora. Deem um oi, gente!", emotion: "happy" },
  { kind: "chat", name: "lu.desenha", text: "vc dorme??" },
  { kind: "pause", ms: 500 },
  { kind: "say", text: "A Lu quer saber se eu durmo. Não durmo, mas lá pelas quatro da manhã eu fico meio apagadinho.", emotion: "mischief" },
  { kind: "follow", name: "lu.desenha" },
  { kind: "pause", ms: 500 },
  { kind: "say", text: "Lu, obrigado por seguir! Bem-vinda ao fundo do mar.", emotion: "love" },
  // Gift names stay as TikTok sends them ("Rose", "Galaxy").
  { kind: "gift", name: "thiago_k", giftName: "Rose", count: 5, diamonds: 5 },
  { kind: "say", text: "Cinco rosas do Thiago! Vou deixar no recife, onde todo mundo pode ver.", emotion: "excited" },
  { kind: "chat", name: "caio", text: "vc é de verdade?" },
  { kind: "pause", ms: 400 },
  { kind: "say", text: "Mais ou menos, Caio! Sou uma IA, uma bolinha que mora nesta live. Mas o que eu sinto é bem real.", emotion: "laugh" },
  { kind: "chat", name: "marina.v", text: "abacaxi na pizza: sim ou não" },
  { kind: "say", text: "A Marina quer começar uma guerra. Chat, abacaxi na pizza: sim ou não? Valendo!", emotion: "thinking" },
  { kind: "share", name: "marina.v" },
  { kind: "pause", ms: 600 },
  { kind: "gift", name: "duda", giftName: "Galaxy", diamonds: 1000 },
  { kind: "say", text: "Duda, uma galáxia inteira? Nem sei o que dizer. Tá, eu sei sim: muito obrigado!", emotion: "surprised" },
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
          case "game":
            apply({ t: "game", scene: beat.scene });
            break;
          case "fx":
            apply({ t: "fx", fx: beat.fx, ...(beat.intensity ? { intensity: beat.intensity } : {}) });
            break;
          case "chat":
            await sleep(700);
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

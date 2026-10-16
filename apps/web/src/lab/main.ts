import { createEngine, startDemo, type StageEngine } from "@tik-live/engine";
import { EMOTIONS, type Emotion, type Look, type StageServerPayload } from "@tik-live/shared";
import "../stage/stage.css";

/**
 * Dev and test harness for the engine (not part of the production build).
 * `?clock=manual` renders deterministic frames for screenshot tests through
 * `window.__lab`; `?demo` plays the scripted show.
 */
const params = new URLSearchParams(location.search);
const manual = params.get("clock") === "manual";
const canvas = document.getElementById("stage") as HTMLCanvasElement;
const engine: StageEngine = createEngine(canvas, {
  mode: params.has("demo") ? "demo" : "program",
  manualClock: manual,
  seed: 7,
  quality: "high",
  muted: true,
});

const lab = {
  engine,
  emotions: EMOTIONS,
  apply: (message: StageServerPayload) => engine.apply(message),
  look: (name: string, look: Look) => engine.setLook(name, look),
  emotion: (emotion: Emotion, hold = 30) => engine.setEmotion(emotion, hold),
  frame: (t: number) => engine.renderAt(t),
  telemetry: () => engine.telemetry(),
  fontsReady: () => document.fonts.ready.then(() => document.fonts.load('720 64px "Bricolage Grotesque"')),
  loseContext() {
    const gl = canvas.getContext("webgl2");
    const ext = gl?.getExtension("WEBGL_lose_context");
    ext?.loseContext();
    return ext;
  },
};
(window as unknown as { __lab: typeof lab }).__lab = lab;

if (params.has("demo")) startDemo(engine);

export {
  BROADCAST_SAMPLE_RATE,
  createEngine,
  Engine,
  ENGINE_VERSION,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  WebGLUnavailableError,
  type EngineEvents,
  type EngineMode,
  type EngineOptions,
  type QualitySetting,
  type StageEngine,
  type Telemetry,
  type Line,
} from "./engine";
export { FrameCapture, type CaptureOptions, type CaptureStats } from "./capture";
export {
  CLOSE_GONE,
  CLOSE_REVOKED,
  connectStage,
  reconnectDelay,
  stageSocketUrl,
  type StageConnection,
  type StageConnectionOptions,
  type StageConnectionState,
} from "./client";
export { DEMO_SCRIPT, estimateLineMs, startDemo, type DemoBeat, type DemoHandle, type DemoOptions } from "./demo";
export { AudioEngine, type AudioState, type PlaybackHandle } from "./audio/audio";
// Music and sound effects: `@tik-live/engine/audio` (kept out of this entry,
// which pages load as a whole, so the stage's first load stays small).
export { syllableCount, syllableEnvelope, type Envelope, type MouthShape } from "./audio/envelope";
export { Spring, SpringVector, SPRINGS, type SpringConfig } from "./anim/spring";
export { QualityGovernor, QUALITY_LEVELS, SampleRing } from "./anim/governor";
export { createRandom } from "./anim/random";
export { layoutCaption, wordAtProgress, type CaptionLayout, type Measure } from "./text/layout";
export { hexToRgb, luminance, mixRgb, rgbToCss, type Rgb } from "./color";
export { Frame, type Layer, type StageContext } from "./stage/layer";
export type { Move } from "./stage/character";

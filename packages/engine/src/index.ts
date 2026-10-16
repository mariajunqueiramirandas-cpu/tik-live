export {
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
} from "./engine";
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
export { syllableCount, syllableEnvelope, type Envelope, type MouthShape } from "./audio/envelope";
export { Spring, SpringVector, SPRINGS, type SpringConfig } from "./anim/spring";
export { QualityGovernor, QUALITY_LEVELS, SampleRing } from "./anim/governor";
export { createRandom } from "./anim/random";
export { layoutCaption, wordAtProgress, type CaptionLayout, type Measure } from "./text/layout";
export { hexToRgb, luminance, mixRgb, rgbToCss, type Rgb } from "./color";

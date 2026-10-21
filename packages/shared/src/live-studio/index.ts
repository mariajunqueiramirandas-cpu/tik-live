/**
 * The TikTok LIVE Studio client the Local Bridge Agent and the server share.
 * Node only (sockets, files, processes): import it as
 * `@tik-live/shared/live-studio`, never from the browser.
 */
export {
  AUTH_REQUIRED_DETAIL,
  LIVE_STUDIO_START_DEADLINE_MS,
  LocalLiveStudioController,
  toStreamStatus,
  type CameraEffectParams,
  type LiveStudioResult,
  type LiveStudioTimings,
  type LocalStudioController,
} from "./controller";
export { StudioAuthError, StudioSocket, type StudioSettings } from "./socket";
export { findDefaultTTStoreDir, injectStageIntoTikTokStore, readLocalTikTokStore, type LocalTikTokStore } from "./store";
export { findLiveStudioExecutable, inertStudioSystem, isTcpPortOpen, windowsStudioSystem, type StudioSystem } from "./system";

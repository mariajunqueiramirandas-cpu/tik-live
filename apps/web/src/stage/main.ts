import { connectStage, createEngine, stageSocketUrl, type QualitySetting, type StageConnectionState } from "@tik-live/engine";
import { STAGE_ROLES, type StageRole } from "@tik-live/shared";
import "./stage.css";

/**
 * The stage page (`/s/:stageKey`): what OBS shows as a browser source and
 * what the cloud broadcaster captures. Query options:
 * `role=program|preview|broadcast`, `quality=auto|high|balanced|low`, `fps=30`.
 */
const params = new URLSearchParams(location.search);
const stageKey = decodeURIComponent(location.pathname.replace(/^\/s\//, "").split("/")[0] ?? "");
const requestedRole = params.get("role") ?? "program";
const role: StageRole = (STAGE_ROLES as readonly string[]).includes(requestedRole) ? (requestedRole as StageRole) : "program";
const requestedQuality = params.get("quality") ?? "auto";
const quality: QualitySetting = ["auto", "high", "balanced", "low"].includes(requestedQuality) ? (requestedQuality as QualitySetting) : "auto";
const fps = Number(params.get("fps")) || undefined;

const canvas = document.getElementById("stage") as HTMLCanvasElement;
const notice = document.getElementById("notice") as HTMLParagraphElement;
const sound = document.getElementById("sound") as HTMLButtonElement;

const engine = createEngine(canvas, { mode: role, quality, ...(fps ? { maxFps: fps } : {}) });

const NOTICES: Partial<Record<StageConnectionState, string>> = {
  revoked: "This stage link was replaced. Copy the new link from your dashboard into OBS.",
  gone: "This host was deleted. Remove this source from OBS.",
};

const connection = connectStage({
  engine,
  url: stageSocketUrl(location, stageKey, role),
  role,
  onState(state) {
    const text = NOTICES[state];
    notice.hidden = !text;
    notice.textContent = text ?? "";
  },
});

// OBS and the broadcaster allow autoplay. A normal browser tab needs one
// click before it may play sound, so offer it (never on a broadcast capture).
const isObs = "obsstudio" in window;
if (role !== "broadcast" && !isObs) {
  const sync = () => {
    sound.hidden = engine.audio.state !== "suspended" || engine.audio.isMuted;
  };
  sound.addEventListener("click", () => void engine.audio.unlock().then(sync));
  engine.audio.onStateChange(sync);
  sync();
}

// The cloud broadcaster drives the page through this handle (ADR-0014, ADR-0020).
// The capture code loads only here, so OBS sources never download it.
if (role === "broadcast") {
  (window as unknown as { __lantern: unknown }).__lantern = {
    engine,
    connection,
    async startCapture(request: import("./capture").CaptureRequest) {
      const { startCapture } = await import("./capture");
      return startCapture(engine, request);
    },
    async captureStats() {
      const { counters } = await import("./capture");
      return { ...engine.captureStats?.(), ...counters };
    },
  };
}

addEventListener("pagehide", () => {
  connection.close();
  engine.destroy();
});

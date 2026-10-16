import { OBSWebSocket } from "obs-websocket-js";
import { createLogger } from "../log.js";

const log = createLogger("obs");

export interface ObsStatus {
  connected: boolean;
  streaming: boolean;
  detail: string;
  congestion?: number;
  skippedFrames?: number;
  totalFrames?: number;
}

export interface ObsSupervisorOptions {
  url: string;
  password?: string;
  /** Start streaming on connect and restart the stream if it drops. */
  autostart: boolean;
}

/**
 * Keeps OBS streaming without a human: connects over obs-websocket (built
 * into OBS 28+), starts the stream, restarts it when it drops unexpectedly,
 * and reports encoder health to the control panel.
 */
export class ObsSupervisor {
  private readonly obs = new OBSWebSocket();
  private status: ObsStatus = { connected: false, streaming: false, detail: "not connected" };
  private stopped = false;
  private restartFailures = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private healthTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ObsSupervisorOptions) {
    this.obs.on("ConnectionClosed", () => {
      this.status = { connected: false, streaming: false, detail: "connection lost" };
      clearInterval(this.healthTimer);
      if (!this.stopped) this.scheduleReconnect(5_000);
    });
    this.obs.on("StreamStateChanged", ({ outputActive, outputState }) => {
      this.status.streaming = outputActive;
      this.status.detail = outputState;
      log.info(`stream state: ${outputState}`);
      if (outputState === "OBS_WEBSOCKET_OUTPUT_STOPPED" && this.options.autostart && !this.stopped) {
        void this.restartStream();
      }
      if (outputActive) this.restartFailures = 0;
    });
  }

  start(): void {
    void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.healthTimer);
    await this.obs.disconnect().catch(() => undefined);
  }

  getStatus(): ObsStatus {
    return { ...this.status };
  }

  private scheduleReconnect(ms: number): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), ms);
  }

  private async connect(): Promise<void> {
    try {
      await this.obs.connect(this.options.url, this.options.password);
      this.status = { connected: true, streaming: false, detail: "connected" };
      log.info(`connected to OBS at ${this.options.url}`);
      const { outputActive } = await this.obs.call("GetStreamStatus");
      this.status.streaming = outputActive;
      if (!outputActive && this.options.autostart) {
        log.info("starting stream");
        await this.obs.call("StartStream");
      }
      clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => void this.pollHealth(), 5_000);
    } catch (err) {
      this.status = { connected: false, streaming: false, detail: `connect failed: ${(err as Error).message}` };
      log.warn(this.status.detail);
      if (!this.stopped) this.scheduleReconnect(10_000);
    }
  }

  private async restartStream(): Promise<void> {
    this.restartFailures += 1;
    const wait = Math.min(60_000, 3_000 * 2 ** Math.min(this.restartFailures - 1, 4));
    log.warn(`stream stopped unexpectedly; restarting in ${Math.round(wait / 1000)}s`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    if (this.stopped) return;
    try {
      const { outputActive } = await this.obs.call("GetStreamStatus");
      if (!outputActive) await this.obs.call("StartStream");
    } catch (err) {
      log.error("restart failed", err);
    }
  }

  private async pollHealth(): Promise<void> {
    try {
      const s = await this.obs.call("GetStreamStatus");
      this.status.streaming = s.outputActive;
      this.status.congestion = s.outputCongestion;
      this.status.skippedFrames = s.outputSkippedFrames;
      this.status.totalFrames = s.outputTotalFrames;
      if (s.outputCongestion > 0.5) log.warn(`network congestion ${(s.outputCongestion * 100).toFixed(0)}%`);
    } catch {
      // ConnectionClosed handles reconnects.
    }
  }
}

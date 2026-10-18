import type { BroadcastStatus, VideoSettings } from "@tik-live/shared";
import type { Secrets } from "../crypto/secrets";
import type { Logger } from "../log";
import type { ChannelRow } from "../repos/channels";
import { BroadcasterError, type BroadcasterClient } from "./client";

/**
 * The cloud broadcast's video by quality. The bitrates sit at the top of what
 * TikTok takes for each size: with x264's fast presets, bits are what keep
 * the motion and the gradients clean.
 */
export const BROADCAST_VIDEO: Record<"720p" | "1080p", VideoSettings> = {
  "720p": { width: 720, height: 1280, fps: 30, bitrateKbps: 4000 },
  "1080p": { width: 1080, height: 1920, fps: 30, bitrateKbps: 6000 },
};

interface Wanted {
  fingerprint: string;
  channel: ChannelRow;
  stageKey: string;
}

/**
 * Keeps the broadcaster in step with the app (ADR-0014): a channel that's
 * running with cloud broadcast on (and allowed by its plan) has a broadcast;
 * nothing else does. Settings or stage-link changes restart it. If the
 * broadcaster restarts and forgets a broadcast, the next poll starts it again.
 */
export class BroadcastSupervisor {
  private readonly wanted = new Map<string, Wanted>();
  private readonly statuses = new Map<string, BroadcastStatus>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      client: BroadcasterClient;
      secrets: Secrets;
      /** Origin the broadcaster loads stage pages from (the app as the broadcaster sees it). */
      stageOrigin: string;
      /** The video to send; 720p when unset. */
      video?: VideoSettings;
      log: Logger;
      pollMs?: number;
      now?: () => number;
    },
  ) {
    this.timer = setInterval(() => void this.poll(), options.pollMs ?? 10_000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Brings one channel's broadcast in line with what it should be. */
  async sync(channel: ChannelRow, stageKey: string, shouldBroadcast: boolean): Promise<void> {
    const b = channel.broadcast;
    const wants = shouldBroadcast && b.enabled && Boolean(b.rtmpUrl && b.streamKeyCiphertext);
    if (!wants) {
      if (this.wanted.has(channel.id)) await this.stop(channel.id);
      return;
    }
    const fingerprint = JSON.stringify([stageKey, b.rtmpUrl, b.streamKeyCiphertext]);
    if (this.wanted.get(channel.id)?.fingerprint === fingerprint) return;
    this.wanted.set(channel.id, { fingerprint, channel, stageKey });
    await this.ensure(channel.id);
  }

  async stop(channelId: string): Promise<void> {
    this.wanted.delete(channelId);
    this.statuses.delete(channelId);
    await this.options.client.stop(channelId).catch((err: unknown) => this.options.log.warn("could not stop broadcast", { channelId, error: String(err) }));
  }

  current(channelId: string): BroadcastStatus | null {
    return this.wanted.has(channelId) ? (this.statuses.get(channelId) ?? null) : null;
  }

  isLive(channelId: string): boolean {
    return this.current(channelId)?.state === "live";
  }

  close(): void {
    clearInterval(this.timer);
  }

  check(rtmpUrl: string): Promise<{ ok: boolean; detail: string }> {
    return this.options.client.check(rtmpUrl).catch((err: unknown) => ({
      ok: false,
      detail: err instanceof BroadcasterError ? err.message : "The broadcast service didn't answer.",
    }));
  }

  private async ensure(channelId: string): Promise<void> {
    const want = this.wanted.get(channelId);
    if (!want) return;
    const { channel, stageKey } = want;
    try {
      const streamKey = await this.options.secrets.decrypt("stream-key", channel.broadcast.streamKeyCiphertext!);
      const status = await this.options.client.start({
        channelId,
        stageUrl: `${this.options.stageOrigin.replace(/\/$/, "")}/s/${encodeURIComponent(stageKey)}`,
        rtmpUrl: channel.broadcast.rtmpUrl!,
        streamKey,
        video: this.options.video ?? BROADCAST_VIDEO["720p"],
      });
      this.statuses.set(channelId, status);
    } catch (err) {
      const message = err instanceof BroadcasterError ? err.message : "Couldn't start the cloud broadcast.";
      this.options.log.warn("cloud broadcast didn't start", { channelId, error: message });
      this.statuses.set(channelId, {
        channelId,
        state: "failed",
        detail: message,
        since: new Date(this.options.now?.() ?? Date.now()).toISOString(),
        restarts: 0,
        stats: null,
      });
    }
  }

  /** Refreshes statuses, and re-requests broadcasts the broadcaster no longer has. */
  async poll(): Promise<void> {
    if (this.wanted.size === 0) return;
    let list;
    try {
      list = await this.options.client.list();
    } catch {
      for (const id of this.wanted.keys()) {
        const prev = this.statuses.get(id);
        if (prev) this.statuses.set(id, { ...prev, state: "retrying", detail: "Não foi possível falar com o serviço de transmissão" });
      }
      return;
    }
    const known = new Map(list.broadcasts.map((b) => [b.channelId, b]));
    for (const id of this.wanted.keys()) {
      const status = known.get(id);
      if (status) this.statuses.set(id, status);
      else await this.ensure(id);
    }
  }
}

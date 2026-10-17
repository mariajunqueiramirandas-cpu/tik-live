import {
  isUnlimited,
  type ChannelRuntimeSummary,
  type RuntimeSnapshot,
  type RuntimeStatus,
  type StageRole,
  type StudioCommand,
} from "@tik-live/shared";
import type { Entitlements, EntitlementCheck } from "../billing/entitlements";
import type { BroadcastSupervisor } from "../broadcast/supervisor";
import type { Secrets } from "../crypto/secrets";
import { getChannelById, listDesiredRunning, setDesiredStateInternal, type ChannelRow } from "../repos/channels";
import type { AudioStore } from "./audio-store";
import { ChannelRuntime, type ChannelRuntimeOptions, type CommandResult, type RuntimeContext } from "./channel-runtime";
import type { Peer } from "./peer";
import { StageHub } from "./stage-hub";
import { StudioFeed } from "./studio-feed";

interface Slot {
  channelId: string;
  ownerId: string;
  stage: StageHub;
  studio: StudioFeed;
  runtime: ChannelRuntime | null;
  /** Last known channel row, for snapshots while stopped. */
  channel: ChannelRow;
  failure: { count: number; timer: ReturnType<typeof setTimeout> | null; message: string } | null;
}

export interface RuntimeManagerOptions {
  ctx: RuntimeContext;
  secrets: Secrets;
  entitlements: Entitlements;
  audio: AudioStore;
  /** Cloud broadcast (ADR-0014); absent when the server has it turned off. */
  broadcasts?: BroadcastSupervisor;
  runtimeOverrides?: Pick<ChannelRuntimeOptions, "makeSource" | "makeHost" | "makeTts">;
}

const BOOT_BATCH = 5;
const PATCH_MS = 250;
const MINUTE_MS = 60_000;

/**
 * Runs every live channel inside this process and keeps actual state equal
 * to desired state (ADR-0007): resumes running channels on boot, restarts
 * failed ones with backoff, enforces plan limits, and drains on shutdown
 * without changing what should be running.
 */
export class RuntimeManager {
  private readonly slots = new Map<string, Slot>();
  private accepting = true;
  private readonly patchTimer: ReturnType<typeof setInterval>;
  private readonly minuteTimer: ReturnType<typeof setInterval>;

  constructor(private readonly options: RuntimeManagerOptions) {
    this.patchTimer = setInterval(() => this.publishPatches(), PATCH_MS);
    this.minuteTimer = setInterval(() => void this.tickMinute(), MINUTE_MS);
  }

  private get log() {
    return this.options.ctx.log;
  }

  /** Starts every channel whose desired state is "running", a few at a time. */
  async boot(): Promise<number> {
    const rows = await listDesiredRunning(this.options.ctx.db);
    for (let i = 0; i < rows.length; i += BOOT_BATCH) {
      await Promise.allSettled(rows.slice(i, i + BOOT_BATCH).map((row) => this.startRow(row, false)));
    }
    if (rows.length) this.log.info(`resumed ${rows.length} running channel${rows.length === 1 ? "" : "s"}`);
    return rows.length;
  }

  runningCountFor(ownerId: string): number {
    let n = 0;
    for (const slot of this.slots.values()) {
      if (slot.ownerId === ownerId && slot.runtime && isActive(slot.runtime.getStatus().status)) n += 1;
    }
    return n;
  }

  /** Starts a channel on the owner's request, checking plan limits first. */
  async start(channel: ChannelRow): Promise<EntitlementCheck> {
    if (!this.accepting) return { ok: false, code: "shutting_down", message: "The server is restarting. Try again in a few seconds." };
    const slot = this.slots.get(channel.id);
    if (slot?.runtime && isActive(slot.runtime.getStatus().status)) return { ok: true };
    const check = await this.options.entitlements.canStart(channel.ownerId, this.runningCountFor(channel.ownerId));
    if (!check.ok) return check;
    await setDesiredStateInternal(this.options.ctx.db, channel.id, "running");
    await this.startRow({ ...channel, desiredState: "running" }, true);
    return { ok: true };
  }

  async stop(channelId: string, reason = "stopped by owner"): Promise<void> {
    await setDesiredStateInternal(this.options.ctx.db, channelId, "stopped");
    const slot = this.slots.get(channelId);
    if (!slot) return;
    if (slot.failure?.timer) clearTimeout(slot.failure.timer);
    slot.failure = null;
    if (slot.runtime) {
      await slot.runtime.stop(reason);
      slot.runtime = null;
    }
    await this.options.broadcasts?.stop(channelId);
    slot.channel = { ...slot.channel, desiredState: "stopped" };
    this.prune(slot);
  }

  /** The owner edited the channel: update stages and the running show. */
  async apply(channel: ChannelRow): Promise<void> {
    const slot = this.slots.get(channel.id);
    if (!slot) return;
    slot.channel = channel;
    slot.stage.setLook(channel.persona.name, channel.persona.look);
    const runtime = slot.runtime;
    if (!runtime || !isActive(runtime.getStatus().status)) return;
    if (runtime.needsRestartFor(channel)) {
      await runtime.stop("restarting with new settings");
      slot.runtime = null;
      await this.startRow(channel, false);
    } else {
      runtime.reconfigure(channel, await this.options.entitlements.planFor(channel.ownerId));
      await this.syncBroadcast(slot);
    }
  }

  async rotateStageKey(channel: ChannelRow, stageKey: string): Promise<void> {
    const slot = this.slots.get(channel.id);
    if (!slot) return;
    slot.channel = channel;
    slot.stage.setStageKey(stageKey);
    // Connected stages used the old key; disconnect them so only the new URL works.
    slot.stage.closeAll(4001, "stage key rotated");
    // The cloud broadcast renders the stage link too: restart it on the new one.
    await this.syncBroadcast(slot);
  }

  async remove(channelId: string): Promise<void> {
    const slot = this.slots.get(channelId);
    if (!slot) return;
    if (slot.failure?.timer) clearTimeout(slot.failure.timer);
    await slot.runtime?.stop("channel deleted");
    await this.options.broadcasts?.stop(channelId);
    slot.stage.closeAll(4004, "channel deleted");
    this.slots.delete(channelId);
  }

  command(channelId: string, command: StudioCommand): CommandResult {
    const runtime = this.slots.get(channelId)?.runtime;
    if (!runtime) return { ok: false, error: "Start the host first." };
    return runtime.command(command);
  }

  summary(channel: ChannelRow): ChannelRuntimeSummary {
    const slot = this.slots.get(channel.id);
    const runtime = slot?.runtime;
    if (runtime) {
      const { status, detail, since } = runtime.getStatus();
      return { status, detail, viewers: runtime.viewers(), since: since ? new Date(since).toISOString() : null };
    }
    if (slot?.failure) return { status: "failed", detail: slot.failure.message, viewers: 0, since: null };
    if (channel.desiredState === "running") return { status: "starting", detail: "Starting", viewers: 0, since: null };
    return { status: "stopped", detail: "", viewers: 0, since: null };
  }

  snapshot(channel: ChannelRow): RuntimeSnapshot {
    const slot = this.slots.get(channel.id);
    if (slot?.runtime) {
      const snapshot = slot.runtime.snapshot();
      const broadcast = this.options.broadcasts?.current(channel.id);
      if (broadcast) {
        snapshot.health.broadcast = { state: broadcast.state, detail: broadcast.detail, bitrateKbps: broadcast.stats?.bitrateKbps ?? null };
      }
      return snapshot;
    }
    const summary = this.summary(channel);
    return stoppedSnapshot(channel, slot?.stage.counts() ?? { program: 0, preview: 0, broadcast: 0 }, summary.status, summary.detail);
  }

  // ---- realtime attachments -------------------------------------------------

  async attachStage(channel: ChannelRow, peer: Peer, role: StageRole): Promise<StageHub> {
    const slot = await this.slotFor(channel);
    slot.stage.attach(peer, role);
    return slot.stage;
  }

  detachStage(channelId: string, peerId: string): void {
    const slot = this.slots.get(channelId);
    if (!slot) return;
    slot.stage.detach(peerId);
    this.prune(slot);
  }

  async attachStudio(channel: ChannelRow, peer: Peer): Promise<void> {
    const slot = await this.slotFor(channel);
    slot.channel = channel;
    slot.studio.attach(peer, this.snapshot(channel));
  }

  detachStudio(channelId: string, peerId: string): void {
    const slot = this.slots.get(channelId);
    if (!slot) return;
    slot.studio.detach(peerId);
    this.prune(slot);
  }

  stageHub(channelId: string): StageHub | undefined {
    return this.slots.get(channelId)?.stage;
  }

  /** Graceful shutdown: hold stages, stop runtimes, keep desired state for the next boot. */
  async shutdown(): Promise<void> {
    this.accepting = false;
    clearInterval(this.patchTimer);
    clearInterval(this.minuteTimer);
    // Cloud broadcasts keep running through an app restart: the stage page
    // holds its last frame and reconnects, and the next boot resyncs.
    this.options.broadcasts?.close();
    for (const slot of this.slots.values()) {
      slot.stage.hold();
      if (slot.failure?.timer) clearTimeout(slot.failure.timer);
    }
    await Promise.allSettled([...this.slots.values()].map((slot) => slot.runtime?.stop("server restarting")));
  }

  // ---- internals ------------------------------------------------------------

  private async slotFor(channel: ChannelRow): Promise<Slot> {
    let slot = this.slots.get(channel.id);
    if (slot) return slot;
    const stageKey = await this.options.secrets.decrypt("stage-key", channel.stageKeyCiphertext);
    // Re-check: another caller may have created the slot while we awaited.
    slot = this.slots.get(channel.id);
    if (slot) return slot;
    slot = {
      channelId: channel.id,
      ownerId: channel.ownerId,
      channel,
      runtime: null,
      failure: null,
      stage: new StageHub({
        channelId: channel.id,
        stageKey,
        name: channel.persona.name,
        look: channel.persona.look,
        audio: this.options.audio,
        log: this.log.child({ channelId: channel.id }),
        ...(this.options.ctx.now ? { now: this.options.ctx.now } : {}),
      }),
      studio: new StudioFeed(),
    };
    this.slots.set(channel.id, slot);
    return slot;
  }

  private async startRow(channel: ChannelRow, _userInitiated: boolean): Promise<void> {
    const slot = await this.slotFor(channel);
    slot.channel = channel;
    if (slot.runtime && isActive(slot.runtime.getStatus().status)) return;
    if (slot.failure?.timer) clearTimeout(slot.failure.timer);
    const plan = await this.options.entitlements.planFor(channel.ownerId);
    const runtime = new ChannelRuntime({
      ctx: this.options.ctx,
      channel,
      plan,
      stage: slot.stage,
      studio: slot.studio,
      ...this.options.runtimeOverrides,
    });
    slot.runtime = runtime;
    try {
      await runtime.start();
      if (slot.failure) slot.failure = { ...slot.failure, timer: null };
      slot.failure = null;
      await this.syncBroadcast(slot);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log.error(`channel ${channel.id} failed to start`, err);
      await runtime.stop("failed to start").catch(() => undefined);
      slot.runtime = null;
      this.scheduleRestart(slot, message);
    }
  }

  private scheduleRestart(slot: Slot, message: string): void {
    const count = (slot.failure?.count ?? 0) + 1;
    const delay = Math.min(5 * 60_000, 5_000 * 2 ** (count - 1));
    slot.studio.publish({
      t: "notice",
      level: "error",
      code: "start_failed",
      message: `The host couldn't start: ${message}. Retrying in ${Math.round(delay / 1000)}s.`,
      at: Date.now(),
    });
    const timer = setTimeout(async () => {
      if (!this.accepting) return;
      const fresh = await getChannelById(this.options.ctx.db, slot.channelId).catch(() => undefined);
      if (!fresh || fresh.desiredState !== "running") {
        slot.failure = null;
        return;
      }
      await this.startRow(fresh, false);
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    slot.failure = { count, timer, message };
  }

  private publishPatches(): void {
    for (const slot of this.slots.values()) {
      if (slot.studio.isEmpty()) continue;
      slot.studio.publishChanges(this.snapshot(slot.channel));
    }
  }

  private async tickMinute(): Promise<void> {
    for (const slot of this.slots.values()) {
      const runtime = slot.runtime;
      if (!runtime || !isActive(runtime.getStatus().status)) continue;
      runtime.tickMinute();
      if (this.options.broadcasts?.isLive(slot.channelId)) runtime.meterBroadcast(60);
      // Picks up plan changes (a downgrade stops the cloud broadcast).
      await this.syncBroadcast(slot).catch(() => undefined);
      const plan = await this.options.entitlements.planFor(slot.ownerId).catch(() => null);
      if (!plan || isUnlimited(plan.limits.liveHoursPerMonth)) continue;
      const used = await this.options.entitlements.liveSecondsThisMonth(slot.ownerId).catch(() => 0);
      if (used + runtime.pendingLiveSeconds() >= plan.limits.liveHoursPerMonth * 3600) {
        slot.studio.publish({
          t: "notice",
          level: "error",
          code: "plan_hours_exhausted",
          message: `You've used all ${plan.limits.liveHoursPerMonth} live hours on the ${plan.name} plan this month, so the host stopped. Upgrade to keep going.`,
          at: Date.now(),
        });
        await this.stop(slot.channelId, "out of live hours");
      }
    }
  }

  private async syncBroadcast(slot: Slot): Promise<void> {
    const broadcasts = this.options.broadcasts;
    if (!broadcasts) return;
    const running = Boolean(slot.runtime && isActive(slot.runtime.getStatus().status));
    const plan = running ? await this.options.entitlements.planFor(slot.ownerId) : null;
    await broadcasts.sync(slot.channel, slot.stage.stageKey, running && Boolean(plan?.limits.cloudBroadcast));
  }

  /** Drops slots nobody uses so memory doesn't grow with every channel ever viewed. */
  private prune(slot: Slot): void {
    if (!slot.runtime && !slot.failure && slot.stage.isEmpty() && slot.studio.isEmpty()) this.slots.delete(slot.channelId);
  }
}

function isActive(status: RuntimeStatus): boolean {
  return status === "starting" || status === "standby" || status === "live";
}

export function stoppedSnapshot(
  channel: ChannelRow,
  stages: { program: number; preview: number; broadcast: number },
  status: RuntimeStatus,
  detail: string,
): RuntimeSnapshot {
  const segment = channel.persona.segments[0]!;
  return {
    status,
    detail,
    paused: false,
    standby: false,
    thinking: false,
    reactOnly: false,
    segment: { id: segment.id, title: segment.title, endsInSec: segment.minutes * 60 },
    segments: channel.persona.segments.map((s) => ({ id: s.id, title: s.title })),
    game: null,
    music: null,
    stats: { viewers: 0, likes: 0, diamonds: 0, messages: 0, follows: 0, uptimeSec: 0 },
    nowSaying: null,
    queue: [],
    filtered: {},
    health: {
      source: { name: channel.source, connected: false, detail: "" },
      stages,
      engine: null,
      brain: { host: "", moderator: null, tts: channel.voice.provider },
      latency: null,
      budget: { usedPct: 0, limitTokensPerHour: null },
    },
    session: null,
  };
}

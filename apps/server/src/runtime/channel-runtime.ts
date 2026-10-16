import Anthropic from "@anthropic-ai/sdk";
import {
  injectEventSchema,
  isUnlimited,
  viewerName,
  type InjectEvent,
  type LiveEvent,
  type LiveEventSummary,
  type Plan,
  type RuntimeSnapshot,
  type RuntimeStatus,
  type StudioCommand,
} from "@tik-live/shared";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { Logger } from "../log";
import type { ChannelRow } from "../repos/channels";
import { addUsage, channelCostOn, dayKey } from "../repos/usage";
import { loadViewers, saveViewers, type ViewerRow } from "../repos/viewers";
import { Director } from "./brain/director";
import { ClaudeHost, ScriptedHost, type HostBrain } from "./brain/host";
import { ViewerMemory, type ViewerPersistence, type ViewerRecord } from "./brain/memory";
import { toUtterance } from "./brain/sentences";
import { Triage, type TriageResult } from "./brain/triage";
import { LatencyTracker } from "./latency";
import { ClaudeModerator, SafetyGate } from "./safety/gate";
import { SimulatorSource } from "./sources/simulator";
import { TikTokSource } from "./sources/tiktok";
import type { EventSource } from "./sources/types";
import type { StageHub } from "./stage-hub";
import { StreamRecorder } from "./stream-recorder";
import type { StudioFeed } from "./studio-feed";
import { UsageMeter, type UsageReport } from "./usage";
import { SpeechPipeline, type SpeechCue } from "./voice/pipeline";
import { ElevenLabsTts, NoTts, type TtsProvider } from "./voice/tts";

export interface RuntimeContext {
  db: Db;
  config: AppConfig;
  anthropic: Anthropic | null;
  log: Logger;
  now?: () => number;
}

export interface ChannelRuntimeOptions {
  ctx: RuntimeContext;
  channel: ChannelRow;
  plan: Plan;
  stage: StageHub;
  studio: StudioFeed;
  /** Overrides for tests. */
  makeSource?: (channel: ChannelRow) => EventSource;
  makeHost?: (channel: ChannelRow) => HostBrain;
  makeTts?: (channel: ChannelRow) => TtsProvider;
  onStatus?: (status: RuntimeStatus, detail: string) => void;
}

const FLUSH_MS = 5_000;
const USAGE_FLUSH_EVERY = 3; // flush ticks
const SAY_LIMIT_PER_MINUTE = 10;
const BUDGET_WARN_RATIO = 0.8;

export type CommandResult = { ok: true } | { ok: false; error: string };

/**
 * One channel's show, assembled from the v0.1 engine: event source → triage →
 * director → host brain → safety ∥ TTS → speech pipeline → stage (ADR-0007).
 */
export class ChannelRuntime {
  readonly channelId: string;
  private channel: ChannelRow;
  private plan: Plan;
  private status: RuntimeStatus = "stopped";
  private detail = "";
  private since: number | null = null;
  private readonly now: () => number;
  private readonly log: Logger;

  private memory!: ViewerMemory;
  private triage!: Triage;
  private gate!: SafetyGate;
  private moderator: ClaudeModerator | null = null;
  private host!: HostBrain;
  private speech!: SpeechPipeline;
  private director!: Director;
  private source!: EventSource;
  private recorder!: StreamRecorder;
  private readonly meter: UsageMeter;
  private readonly latency = new LatencyTracker();
  private flushTimer: ReturnType<typeof setInterval> | undefined;
  private flushCount = 0;
  private lastTickAt: number;
  private budgetWarned = false;
  private dailyCapNoticed = false;
  private sayTimes: number[] = [];
  private eventCounter = 0;

  constructor(private readonly options: ChannelRuntimeOptions) {
    this.channel = options.channel;
    this.plan = options.plan;
    this.channelId = options.channel.id;
    this.now = options.ctx.now ?? Date.now;
    this.meter = new UsageMeter(this.now);
    this.lastTickAt = this.now();
    this.log = options.ctx.log.child({ channelId: this.channelId }, (entry) => {
      if (entry.level === "debug") return;
      this.options.studio.publish({ t: "log", level: entry.level, msg: entry.msg, at: entry.at });
    });
  }

  getStatus(): { status: RuntimeStatus; detail: string; since: number | null } {
    return { status: this.status, detail: this.detail, since: this.since };
  }

  viewers(): number {
    return this.director?.stats().viewers ?? 0;
  }

  async start(): Promise<void> {
    if (this.status !== "stopped" && this.status !== "failed") return;
    this.setStatus("starting", "Getting ready");
    const { ctx, stage } = this.options;
    const channel = this.channel;

    // Today's earlier spend counts toward the daily cap, even across restarts.
    const today = dayKey(new Date(this.now()));
    this.meter.seedToday(today, await channelCostOn(ctx.db, channel.id, today).catch(() => 0));
    this.memory = new ViewerMemory({ persistence: this.persistence(), now: this.now, log: this.log });
    this.triage = new Triage({ blocklist: channel.safety.blocklist, hostName: channel.persona.name, memory: this.memory, now: this.now });

    const ai = ctx.anthropic;
    this.moderator =
      ai && ctx.config.MODERATION_ENABLED
        ? new ClaudeModerator({ client: ai, model: ctx.config.MODERATION_MODEL ?? this.plan.models.moderator, settings: channel.safety, onUsage: (u) => this.usage(u) })
        : null;
    this.gate = new SafetyGate({
      blocklist: channel.safety.blocklist,
      failOpen: ctx.config.MODERATION_FAIL_OPEN,
      log: this.log,
      ...(this.moderator ? { moderator: this.moderator } : {}),
    });
    this.host = this.options.makeHost?.(channel) ?? this.defaultHost(channel);

    this.speech = new SpeechPipeline(
      this.options.makeTts?.(channel) ?? this.defaultTts(channel),
      this.gate,
      stage,
      {
        onSpoken: (cue) => this.onSpoken(cue),
        onDropped: (text, reason, emotion, meta) => {
          this.recorder.line({ text, emotion, status: "blocked", reason, ...(meta ? { turnKind: meta.turnKind } : {}) });
          this.options.studio.publish({
            t: "transcript",
            line: { id: Bun.randomUUIDv7(), at: this.now(), text, emotion, status: "blocked", reason },
          });
        },
        onUsage: (u) => this.usage(u),
        log: this.log,
      },
      this.now,
    );
    stage.setCueListener((cue, at) => {
      if (cue.meta?.first) this.latency.record(at - cue.meta.originAt);
    });

    this.recorder = new StreamRecorder(ctx.db, channel.id, channel.source, this.log, this.now);
    this.source = this.options.makeSource?.(channel) ?? this.defaultSource(channel);
    const simulated = this.source.name === "simulator";

    this.director = new Director({
      persona: channel.persona,
      host: this.host,
      triage: this.triage,
      memory: this.memory,
      speech: this.speech,
      stage,
      deadAirMs: 7_000,
      startInStandby: !simulated,
      log: this.log,
      now: this.now,
      hooks: {
        onEvent: (event, result) => this.onEvent(event, result),
        onTurn: () => this.recorder.countTurn(),
        onTurnFailed: (err) =>
          this.notice("warn", "turn_failed", `The host couldn't think of a reply (${err instanceof Error ? err.message : "unknown error"}). Retrying shortly.`),
        onStandbyChange: (standby) => void this.onStandbyChange(standby),
      },
    });

    await this.source.start((event) => {
      try {
        this.director.handleEvent(event);
      } catch (err) {
        this.log.error("failed to handle a live event", err);
      }
    });
    this.director.start();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_MS);
    this.lastTickAt = this.now();

    if (simulated) {
      await this.recorder.begin();
      this.director.resetSession();
      this.setStatus("live", "Test mode: simulated audience");
    } else {
      this.setStatus("standby", `Waiting for @${channel.tiktokUsername} to go live on TikTok`);
    }
    this.log.info(`host started (${this.host.name}, ${this.speech.ttsName} voice, ${this.source.name})`);
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") return;
    this.setStatus("stopping", "Stopping");
    clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.director?.stop();
    this.speech?.stop();
    this.options.stage.setCueListener(null);
    await this.source?.stop().catch((err) => this.log.warn("source stop failed", err));
    this.accrue();
    // Parts may be missing if start() failed halfway; stop whatever exists.
    if (this.recorder && this.director) {
      await this.recorder.end(reason, this.director.stats()).catch((err) => this.log.warn("could not close the stream session", err));
    }
    await this.memory?.flush().catch((err) => this.log.warn("could not save viewer memory", err));
    await this.flushUsage().catch((err) => this.log.warn("could not save usage", err));
    this.setStatus("stopped", "");
    this.log.info(`host stopped (${reason})`);
  }

  /** Applies edited settings while live: persona, safety and voice change in place. */
  reconfigure(channel: ChannelRow, plan: Plan): void {
    const previous = this.channel;
    this.channel = channel;
    this.plan = plan;
    if (this.status === "stopped" || this.status === "stopping" || !this.director) return;
    this.triage.reconfigure({ blocklist: channel.safety.blocklist, hostName: channel.persona.name });
    this.gate.setBlocklist(channel.safety.blocklist);
    this.moderator?.updateSettings(channel.safety);
    this.host.reconfigure({ persona: channel.persona, safety: channel.safety });
    this.director.reconfigure(channel.persona);
    if (JSON.stringify(previous.voice) !== JSON.stringify(channel.voice)) {
      this.speech.setTts(this.options.makeTts?.(channel) ?? this.defaultTts(channel));
    }
  }

  /** Whether a restart is needed to apply this change (different audience source). */
  needsRestartFor(channel: ChannelRow): boolean {
    return channel.source !== this.channel.source || channel.tiktokUsername !== this.channel.tiktokUsername;
  }

  command(command: StudioCommand): CommandResult {
    if (!this.director || this.status === "stopped" || this.status === "stopping") {
      return { ok: false, error: "Start the host first." };
    }
    switch (command.kind) {
      case "pause":
        this.director.pause();
        this.notice("warn", "paused", "Host paused. Nothing will be said until you resume.");
        return { ok: true };
      case "resume":
        this.director.resume();
        this.notice("info", "resumed", "Host resumed.");
        return { ok: true };
      case "skip":
        this.director.skip();
        return { ok: true };
      case "segment":
        return this.director.forceSegment(command.id) ? { ok: true } : { ok: false, error: "That segment doesn't exist." };
      case "say": {
        const now = this.now();
        this.sayTimes = this.sayTimes.filter((t) => now - t < 60_000);
        if (this.sayTimes.length >= SAY_LIMIT_PER_MINUTE) return { ok: false, error: "That's a lot of lines in a minute. Wait a moment." };
        const utterance = toUtterance(command.text);
        if (!utterance) return { ok: false, error: "There's nothing speakable in that line." };
        this.sayTimes.push(now);
        this.speech.enqueue(utterance, { trusted: true });
        return { ok: true };
      }
      case "inject": {
        const parsed = injectEventSchema.safeParse(command.event);
        if (!parsed.success) return { ok: false, error: "That test event isn't valid." };
        this.director.handleEvent(this.toLiveEvent(parsed.data));
        return { ok: true };
      }
    }
  }

  /** Called once a minute by the manager: accrues live time and enforces the AI budgets. */
  tickMinute(): void {
    this.accrue();
    if (!this.director) return;
    const limit = this.plan.limits.tokenBudgetPerHour;
    const cap = this.plan.limits.dailySpendCapUsd;
    const used = this.meter.tokensLastHour();
    const hourly = !isUnlimited(limit) && used >= limit;
    const daily = !isUnlimited(cap) && this.meter.spentToday() >= cap;
    this.director.setBudgetReactOnly(hourly || daily);
    if (daily) {
      if (!this.dailyCapNoticed) {
        this.dailyCapNoticed = true;
        this.notice("warn", "daily_cap_reached", "This host reached today's AI spending limit. It still reacts to viewers, and fills quiet moments again after midnight UTC.");
      }
      return;
    }
    this.dailyCapNoticed = false;
    if (isUnlimited(limit)) return;
    if (hourly) {
      this.notice("warn", "budget_reached", "This host used its hourly AI budget. It will still react to viewers but won't fill quiet moments for a while.");
    } else if (used >= limit * BUDGET_WARN_RATIO && !this.budgetWarned) {
      this.budgetWarned = true;
      this.notice("info", "budget_warning", "This host is close to its hourly AI budget.");
    } else if (used < limit * BUDGET_WARN_RATIO) {
      this.budgetWarned = false;
    }
  }

  /** Cloud-broadcast time, metered separately from live hours (ADR-0013). */
  meterBroadcast(seconds: number): void {
    this.meter.addBroadcastSeconds(seconds);
  }

  /** Live seconds recorded since the last flush (counted toward plan hours). */
  pendingLiveSeconds(): number {
    return this.status === "live" ? Math.floor((this.now() - this.lastTickAt) / 1000) : 0;
  }

  snapshot(): RuntimeSnapshot {
    const d = this.director?.state();
    const stats = d?.stats;
    const segment = d?.segment ?? this.channel.persona.segments[0]!;
    const limit = this.plan.limits.tokenBudgetPerHour;
    const telemetry = this.options.stage.engineTelemetry();
    const source = this.source?.status() ?? { name: this.channel.source, connected: false, live: false, detail: "" };
    return {
      status: this.status,
      detail: this.detail,
      paused: d?.paused ?? false,
      standby: d?.standby ?? false,
      thinking: Boolean(d?.turnInFlight),
      reactOnly: d?.reactOnly ?? false,
      segment: { id: segment.id, title: segment.title, endsInSec: d?.segmentEndsInSec ?? segment.minutes * 60 },
      segments: this.channel.persona.segments.map((s) => ({ id: s.id, title: s.title })),
      stats: {
        viewers: stats?.viewers ?? 0,
        likes: stats?.likes ?? 0,
        diamonds: stats?.diamonds ?? 0,
        messages: stats?.messages ?? 0,
        follows: stats?.follows ?? 0,
        uptimeSec: this.since && this.status === "live" ? Math.floor((this.now() - this.since) / 1000) : 0,
      },
      nowSaying: this.speech?.nowPlaying() ? { text: this.speech.nowPlaying()!.text, emotion: this.speech.nowPlaying()!.emotion } : null,
      queue: (this.triage?.peek() ?? []).slice(0, 12).map((item) => ({
        kind: item.event.kind,
        who: "viewer" in item.event ? viewerName(item.event.viewer) : "",
        text: "text" in item.event ? item.event.text : "giftName" in item.event ? `${item.event.count}x ${item.event.giftName}` : "",
        priority: Math.round(item.priority),
      })),
      filtered: Object.fromEntries(this.triage?.dropped ?? []),
      health: {
        source: { name: source.name, connected: source.connected, detail: source.detail },
        stages: this.options.stage.counts(),
        engine: telemetry
          ? { fps: telemetry.fps, frameP95: telemetry.frameP95, quality: telemetry.quality, renderer: telemetry.renderer, error: telemetry.error }
          : null,
        brain: { host: this.host?.name ?? "", moderator: this.gate?.moderatorModel ?? null, tts: this.speech?.ttsName ?? "none" },
        latency: this.latency.summary(),
        budget: {
          usedPct: isUnlimited(limit) ? 0 : Math.min(100, Math.round((this.meter.tokensLastHour() / limit) * 100)),
          limitTokensPerHour: isUnlimited(limit) ? null : limit,
        },
      },
      session: this.recorder?.current ?? null,
    };
  }

  // ---- internals ----------------------------------------------------------

  private setStatus(status: RuntimeStatus, detail: string): void {
    if (status !== this.status) this.since = this.now();
    this.status = status;
    this.detail = detail;
    this.options.onStatus?.(status, detail);
  }

  private notice(level: "info" | "warn" | "error", code: string, message: string): void {
    this.options.studio.publish({ t: "notice", level, code, message, at: this.now() });
  }

  private usage(report: UsageReport): void {
    this.meter.record(report);
    this.recorder?.addUsage(report);
  }

  private onSpoken(cue: SpeechCue): void {
    this.director.noteSpoken(cue.text);
    this.recorder.line({ text: cue.text, emotion: cue.emotion, status: "spoken", ...(cue.meta ? { turnKind: cue.meta.turnKind } : {}) });
    this.options.studio.publish({
      t: "transcript",
      line: { id: cue.id, at: this.now(), text: cue.text, emotion: cue.emotion, status: "spoken", ...(cue.operator ? { operator: true } : {}) },
    });
  }

  private onEvent(event: LiveEvent, result: TriageResult | null): void {
    this.recorder.observe(event);
    const summary = this.summarize(event, result);
    if (summary) this.options.studio.publish({ t: "live-event", event: summary });
  }

  private async onStandbyChange(standby: boolean): Promise<void> {
    if (standby) {
      this.accrue();
      await this.recorder.end("stream ended", this.director.stats()).catch((err) => this.log.warn("could not close the stream session", err));
      this.setStatus("standby", `Waiting for @${this.channel.tiktokUsername} to go live on TikTok`);
    } else {
      this.director.resetSession();
      await this.recorder.begin().catch((err) => this.log.warn("could not open a stream session", err));
      this.lastTickAt = this.now();
      this.setStatus("live", `Live on TikTok as @${this.channel.tiktokUsername}`);
    }
  }

  private summarize(event: LiveEvent, result: TriageResult | null): LiveEventSummary | null {
    if (event.kind === "like" || event.kind === "viewers" || event.kind === "stream_end") return null;
    const base = { id: `${event.at}-${++this.eventCounter}`, at: event.at, kind: event.kind, who: viewerName(event.viewer) };
    const filtered = result && !result.queued && result.reason !== "not queueable" && result.reason !== "join from new viewer" ? { filtered: result.reason } : {};
    switch (event.kind) {
      case "chat":
      case "question":
        return { ...base, text: event.text, ...filtered };
      case "gift":
        return { ...base, giftName: event.giftName, count: event.count, diamonds: event.diamonds };
      default:
        return base;
    }
  }

  private toLiveEvent(input: InjectEvent): LiveEvent {
    const viewer = { id: `test:${input.handle}`, handle: input.handle, nickname: input.handle };
    const at = this.now();
    switch (input.kind) {
      case "chat":
        return { kind: "chat", at, viewer, text: input.text };
      case "gift":
        return { kind: "gift", at, viewer, giftName: input.giftName, count: input.count, diamonds: input.diamonds * input.count };
      case "follow":
        return { kind: "follow", at, viewer };
      case "share":
        return { kind: "share", at, viewer };
    }
  }

  private accrue(): void {
    const seconds = this.pendingLiveSeconds();
    this.lastTickAt = this.now();
    if (seconds > 0) this.meter.addRuntimeSeconds(seconds);
  }

  private async flush(): Promise<void> {
    this.flushCount += 1;
    const tasks: Array<Promise<unknown>> = [
      this.memory.flush().catch((err) => this.log.warn("could not save viewer memory", err)),
      this.recorder.flush(this.director.stats()).catch(() => undefined),
    ];
    if (this.flushCount % USAGE_FLUSH_EVERY === 0) {
      this.accrue();
      tasks.push(this.flushUsage().catch((err) => this.log.warn("could not save usage", err)));
    }
    await Promise.all(tasks);
  }

  private async flushUsage(): Promise<void> {
    if (!this.meter.hasPending()) return;
    const delta = this.meter.drain();
    await addUsage(this.options.ctx.db, { userId: this.channel.ownerId, channelId: this.channel.id, day: dayKey(new Date(this.now())) }, delta);
  }

  private persistence(): ViewerPersistence {
    const { db } = this.options.ctx;
    const channelId = this.channel.id;
    return {
      load: async (ids) => (await loadViewers(db, channelId, ids)).map(fromRow),
      save: (records) => saveViewers(db, records.map((record) => toRow(channelId, record))),
    };
  }

  private defaultHost(channel: ChannelRow): HostBrain {
    const { ctx } = this.options;
    if (!ctx.anthropic) return new ScriptedHost(channel.persona);
    return new ClaudeHost({
      client: ctx.anthropic,
      persona: channel.persona,
      safety: channel.safety,
      memory: this.memory,
      model: ctx.config.HOST_MODEL ?? this.plan.models.host,
      effort: ctx.config.HOST_EFFORT,
      onUsage: (u) => this.usage(u),
      log: this.log,
    });
  }

  private defaultTts(channel: ChannelRow): TtsProvider {
    const { config } = this.options.ctx;
    if (!config.ELEVENLABS_API_KEY || channel.voice.provider !== "elevenlabs") return new NoTts();
    const voiceId = this.plan.limits.voices === "curated" ? channel.voice.voiceId ?? config.DEFAULT_VOICE_ID : config.DEFAULT_VOICE_ID;
    if (!voiceId) return new NoTts();
    return new ElevenLabsTts({ apiKey: config.ELEVENLABS_API_KEY, voiceId, model: config.ELEVENLABS_MODEL });
  }

  private defaultSource(channel: ChannelRow): EventSource {
    if (channel.source === "tiktok" && channel.tiktokUsername) {
      return new TikTokSource({
        username: channel.tiktokUsername,
        log: this.log,
        ...(this.options.ctx.config.EULER_API_KEY ? { signApiKey: this.options.ctx.config.EULER_API_KEY } : {}),
      });
    }
    return new SimulatorSource({ rate: 0.5 });
  }
}

function fromRow(row: ViewerRow): ViewerRecord {
  return {
    id: row.platformUserId,
    handle: row.handle,
    nickname: row.nickname,
    firstSeen: row.firstSeenAt.getTime(),
    lastSeen: row.lastSeenAt.getTime(),
    visits: row.visits,
    messages: row.messages,
    diamonds: row.diamonds,
    gifts: row.gifts,
    follows: row.follows,
    shares: row.shares,
    recentLines: row.recentLines,
    notes: row.notes,
  };
}

function toRow(channelId: string, record: ViewerRecord): ViewerRow {
  return {
    channelId,
    platformUserId: record.id,
    handle: record.handle,
    nickname: record.nickname,
    firstSeenAt: new Date(record.firstSeen),
    lastSeenAt: new Date(record.lastSeen),
    visits: record.visits,
    messages: record.messages,
    diamonds: record.diamonds,
    gifts: record.gifts,
    follows: record.follows,
    shares: record.shares,
    recentLines: record.recentLines,
    notes: record.notes,
  };
}

import Anthropic from "@anthropic-ai/sdk";
import {
  injectEventSchema,
  isUnlimited,
  MUSIC_LIBRARY,
  musicTrackSchema,
  passSeconds,
  viewerName,
  type InjectEvent,
  type LiveEvent,
  type LiveEventSummary,
  type MusicTrack,
  type Plan,
  type RuntimeSnapshot,
  type RuntimeStatus,
  type StudioCommand,
} from "@tik-live/shared";
import type { AppConfig } from "../config";
import type { Db } from "../db/client";
import type { Logger } from "../log";
import type { ChannelRow } from "../repos/channels";
import { latestSummary } from "../repos/streams";
import { addUsage, channelCostOn, dayKey } from "../repos/usage";
import { loadViewers, saveViewers, type ViewerRow } from "../repos/viewers";
import { ClaudeChronicler } from "./brain/chronicle";
import { Director } from "./brain/director";
import { ClaudeHost, ScriptedHost, type HostBrain } from "./brain/host";
import { ViewerMemory, type ViewerPersistence, type ViewerRecord } from "./brain/memory";
import { toUtterance } from "./brain/sentences";
import { Triage, type TriageResult } from "./brain/triage";
import { GameMaster } from "./games/master";
import { LoopRanking } from "./games/ranking";
import { ClaudeGameWriter } from "./games/writer";
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
import { ElevenLabsTts, NoTts, PocketTts, type TtsProvider } from "./voice/tts";

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
/** The host composes at most one piece of music this often. */
const HOST_MUSIC_GAP_MS = 90_000;

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
  private games!: GameMaster;
  private ranking!: LoopRanking;
  /** The piece of music on stage, if any. */
  private music: { title: string; endsAt: number; byHost: boolean } | null = null;
  private hostMusicAt = -Infinity;
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
    this.setStatus("starting", "Preparando");
    const { ctx, stage } = this.options;
    const channel = this.channel;

    // Today's earlier spend counts toward the daily cap, even across restarts.
    const today = dayKey(new Date(this.now()));
    this.meter.seedToday(today, await channelCostOn(ctx.db, channel.id, today).catch(() => 0));
    // How the last stream went, so the host can open with a callback to it.
    const lastStream = await latestSummary(ctx.db, channel.id).catch(() => null);
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
    const tts = this.options.makeTts?.(channel) ?? this.defaultTts(channel);
    this.host = this.options.makeHost?.(channel) ?? this.defaultHost(channel, tts.language);

    this.speech = new SpeechPipeline(
      tts,
      this.gate,
      stage,
      {
        onSpoken: (cue) => this.onSpoken(cue),
        onDropped: (text, reason, emotion, meta) => {
          this.director.noteBlocked(text, meta);
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

    const sounds = () => this.channel.persona.sound?.effects !== false;
    this.ranking = new LoopRanking({ stage, sounds, now: this.now, log: this.log });
    this.games = new GameMaster({
      writer: ai ? new ClaudeGameWriter({ client: ai, model: ctx.config.HOST_MODEL ?? this.plan.models.host, onUsage: (u) => this.usage(u), log: this.log }) : null,
      gate: this.gate,
      stage,
      blocklist: () => this.channel.safety.blocklist,
      // The product is Brazilian: games are in Portuguese unless the voice only speaks another language.
      language: () => this.speech.ttsLanguage ?? "pt-BR",
      sounds,
      ranking: this.ranking,
      now: this.now,
      log: this.log,
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
      games: this.games,
      ranking: this.ranking,
      ...(ai && this.host instanceof ClaudeHost
        ? {
            chronicler: new ClaudeChronicler({
              client: ai,
              model: ctx.config.MODERATION_MODEL ?? this.plan.models.moderator,
              memory: this.memory,
              blocklist: () => this.channel.safety.blocklist,
              onUsage: (u) => this.usage(u),
              log: this.log,
            }),
          }
        : {}),
      actions: { playMusic: (track) => void this.playMusic(track, true) },
      blocklist: () => this.channel.safety.blocklist,
      ...(lastStream ? { lastStream } : {}),
      log: this.log,
      now: this.now,
      hooks: {
        onEvent: (event, result) => this.onEvent(event, result),
        onTurn: () => this.recorder.countTurn(),
        onSummary: (summary) => this.recorder.summary(summary),
        onTurnFailed: (err) =>
          this.notice("warn", "turn_failed", `O apresentador não conseguiu pensar numa resposta (${err instanceof Error ? err.message : "erro desconhecido"}). Tentando de novo em instantes.`),
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
      this.setStatus("live", "Modo de treino: plateia simulada");
    } else {
      this.setStatus("standby", `Aguardando @${channel.tiktokUsername} entrar ao vivo no TikTok`);
    }
    this.log.info(`host started (${this.host.name}, ${this.speech.ttsName} voice, ${this.source.name})`);
  }

  async stop(reason = "stopped"): Promise<void> {
    if (this.status === "stopped" || this.status === "stopping") return;
    this.setStatus("stopping", "Parando");
    clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    this.director?.stop();
    this.speech?.stop();
    this.stopMusic();
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
    let speechLanguage: string | null | undefined;
    if (JSON.stringify(previous.voice) !== JSON.stringify(channel.voice)) {
      const tts = this.options.makeTts?.(channel) ?? this.defaultTts(channel);
      this.speech.setTts(tts);
      speechLanguage = tts.language ?? null;
    }
    this.host.reconfigure({ persona: channel.persona, safety: channel.safety, ...(speechLanguage !== undefined ? { speechLanguage } : {}) });
    this.director.reconfigure(channel.persona);
  }

  /** Whether a restart is needed to apply this change (different audience source). */
  needsRestartFor(channel: ChannelRow): boolean {
    return channel.source !== this.channel.source || channel.tiktokUsername !== this.channel.tiktokUsername;
  }

  command(command: StudioCommand): CommandResult {
    if (!this.director || this.status === "stopped" || this.status === "stopping") {
      return { ok: false, error: "Coloque o apresentador no ar primeiro." };
    }
    switch (command.kind) {
      case "pause":
        this.director.pause();
        this.notice("warn", "paused", "Apresentador pausado. Nada será dito até você retomar.");
        return { ok: true };
      case "resume":
        this.director.resume();
        this.notice("info", "resumed", "Apresentador retomado.");
        return { ok: true };
      case "skip":
        this.director.skip();
        return { ok: true };
      case "segment":
        return this.director.forceSegment(command.id) ? { ok: true } : { ok: false, error: "Esse quadro não existe." };
      case "say": {
        const now = this.now();
        this.sayTimes = this.sayTimes.filter((t) => now - t < 60_000);
        if (this.sayTimes.length >= SAY_LIMIT_PER_MINUTE) return { ok: false, error: "São muitas falas em um minuto. Espere um pouco." };
        const utterance = toUtterance(command.text);
        if (!utterance) return { ok: false, error: "Não tem nada para falar nessa frase." };
        this.sayTimes.push(now);
        // Right after the sentence on stage, ahead of the host's queued lines.
        this.speech.enqueue(utterance, { trusted: true, front: true });
        return { ok: true };
      }
      case "inject": {
        const parsed = injectEventSchema.safeParse(command.event);
        if (!parsed.success) return { ok: false, error: "Esse evento de teste não é válido." };
        this.director.handleEvent(this.toLiveEvent(parsed.data));
        return { ok: true };
      }
      case "game_start":
        return this.games.start(command.game, "studio", this.director.chatSample());
      case "game_stop":
        // The loop's podium is shown like a game, so the same button ends it.
        if (this.ranking.isRevealing()) {
          this.ranking.stop();
          return { ok: true };
        }
        if (!this.games.isActive()) return { ok: false, error: "Nenhum jogo está rolando." };
        this.games.stop();
        return { ok: true };
      case "music_play": {
        if (this.channel.persona.sound?.music === false) return { ok: false, error: "A música está desligada para este apresentador. Ligue em Personagem." };
        if (command.library) {
          const track = musicTrackSchema.parse(MUSIC_LIBRARY[command.library]);
          void this.playMusic(track, false);
          return { ok: true };
        }
        if (command.prompt && !(this.host instanceof ClaudeHost)) {
          // The offline host can't compose; play something from the library instead.
          const ids = Object.keys(MUSIC_LIBRARY);
          const pick = ids[Math.floor(Math.random() * ids.length)] as string;
          void this.playMusic(musicTrackSchema.parse(MUSIC_LIBRARY[pick]), false);
          return { ok: true };
        }
        if (command.prompt) {
          this.director.request(
            `Compose and play a short original piece with the play_music tool, in this style: "${command.prompt}". Introduce it in one short line first.`,
          );
          return { ok: true };
        }
        return { ok: false, error: "Escolha uma música ou descreva uma." };
      }
      case "music_stop":
        this.stopMusic();
        return { ok: true };
    }
  }

  /** Puts a piece of music on stage. The host's own pieces are rate-limited and checked like speech. */
  private async playMusic(track: MusicTrack, byHost: boolean): Promise<void> {
    if (this.channel.persona.sound?.music === false) return;
    const now = this.now();
    if (byHost) {
      if (now - this.hostMusicAt < HOST_MUSIC_GAP_MS) {
        this.log.info("skipped the host's music: it played some a moment ago");
        return;
      }
      if (this.games.status()?.phase === "open") {
        this.log.info("skipped the host's music: a game round is open");
        return;
      }
      this.hostMusicAt = now;
      // The title is shown on stage, so it passes the same gate as speech.
      const verdict = await this.gate.check(track.title, "The title of a short piece of music the host composed.");
      if (!verdict.safe) {
        this.log.warn(`blocked the host's music title (${verdict.reason})`);
        return;
      }
    }
    if (this.status === "stopped" || this.status === "stopping") return;
    const endsAt = this.now() + passSeconds(track.bpm, track.bars) * track.repeat * 1000;
    this.music = { title: track.title, endsAt, byHost };
    this.options.stage.music(track, endsAt);
    this.director.noteMusic({ title: track.title, endsAt, byHost });
    this.log.info(`playing "${track.title}" (${byHost ? "composed by the host" : "from the library"})`);
  }

  private stopMusic(): void {
    if (!this.music) return;
    this.music = null;
    this.options.stage.music(null);
    this.director?.noteMusic(null);
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
        this.notice("warn", "daily_cap_reached", "Este apresentador atingiu o limite de gasto com IA de hoje. Ele continua respondendo ao chat e volta a puxar assunto depois da meia-noite (UTC).");
      }
      return;
    }
    this.dailyCapNoticed = false;
    if (isUnlimited(limit)) return;
    if (hourly) {
      this.notice("warn", "budget_reached", "Este apresentador usou o orçamento de IA desta hora. Ele continua respondendo ao chat, mas não vai puxar assunto por um tempo.");
    } else if (used >= limit * BUDGET_WARN_RATIO && !this.budgetWarned) {
      this.budgetWarned = true;
      this.notice("info", "budget_warning", "Este apresentador está perto do orçamento de IA desta hora.");
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
      game: this.games?.status() ?? null,
      upNext: (this.director?.upNext() ?? []).map((item) => ({ kind: item.kind, title: item.title, inSec: Math.max(0, Math.ceil((item.at - this.now()) / 1000)) })),
      leaders: this.director?.leaders() ?? { likes: [], gifts: [] },
      ranking: this.ranking?.status() ?? { rows: [], games: 0, revealing: false },
      vote: this.director?.voteStatus() ?? null,
      music: this.music && this.music.endsAt > this.now()
        ? { title: this.music.title, endsInSec: Math.ceil((this.music.endsAt - this.now()) / 1000), byHost: this.music.byHost }
        : null,
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
        brain: {
          host: this.host?.name ?? "",
          moderator: this.gate?.moderatorModel ?? null,
          tts: this.speech?.ttsName ?? "none",
          context: this.host?.contextStats?.() ?? null,
        },
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
    this.director.noteSpoken(cue.text, cue.meta, cue.operator === true);
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
      this.setStatus("standby", `Aguardando @${this.channel.tiktokUsername} entrar ao vivo no TikTok`);
    } else {
      this.director.resetSession();
      await this.recorder.begin().catch((err) => this.log.warn("could not open a stream session", err));
      this.lastTickAt = this.now();
      this.setStatus("live", `Ao vivo no TikTok como @${this.channel.tiktokUsername}`);
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

  private defaultHost(channel: ChannelRow, speechLanguage: string | undefined): HostBrain {
    const { ctx } = this.options;
    if (!ctx.anthropic) return new ScriptedHost(channel.persona);
    return new ClaudeHost({
      client: ctx.anthropic,
      persona: channel.persona,
      safety: channel.safety,
      ...(speechLanguage ? { speechLanguage } : {}),
      model: ctx.config.HOST_MODEL ?? this.plan.models.host,
      effort: ctx.config.HOST_EFFORT,
      onUsage: (u) => this.usage(u),
      log: this.log,
    });
  }

  private defaultTts(channel: ChannelRow): TtsProvider {
    const { config } = this.options.ctx;
    const curated = this.plan.limits.voices === "curated";
    if (channel.voice.provider === "pocket" && config.pocketEnabled) {
      const voice = (curated ? channel.voice.voiceId : null) ?? config.POCKET_TTS_VOICE;
      return new PocketTts({ url: config.POCKET_TTS_URL!, secret: config.POCKET_TTS_SECRET!, voice });
    }
    if (!config.ELEVENLABS_API_KEY || channel.voice.provider !== "elevenlabs") return new NoTts();
    const voiceId = curated ? channel.voice.voiceId ?? config.DEFAULT_VOICE_ID : config.DEFAULT_VOICE_ID;
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

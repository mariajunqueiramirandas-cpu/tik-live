import {
  disclosureText,
  parseMessage,
  PROTOCOL_VERSION,
  stageClientMessageSchema,
  type LiveEvent,
  type Look,
  type Segment,
  type StageRole,
  type StageServerPayload,
} from "@tik-live/shared";
import type { Logger } from "../log";
import type { AudioStore } from "./audio-store";
import type { StageNotifier } from "./brain/director";
import { BACKPRESSURE_BYTES, type Peer } from "./peer";
import type { SpeechCue, SpeechOutput } from "./voice/pipeline";

/** Time a stage gets to fetch and decode a line before it must have started. */
const START_GRACE_MS = 4_000;
/** Extra time past a started line's real duration before we move on anyway. */
const END_GRACE_MS = 1_500;
/** Stats change with every like; stages need them a few times a second at most. */
const STATS_INTERVAL_MS = 250;

export interface EngineTelemetry {
  fps: number;
  frameP95: number;
  quality: number;
  renderer: string | null;
  error: string | null;
  at: number;
}

interface StagePeer {
  peer: Peer;
  role: StageRole;
}

export interface StageHubOptions {
  channelId: string;
  stageKey: string;
  name: string;
  look: Look;
  audio: AudioStore;
  log?: Logger;
  now?: () => number;
}

export type CueListener = (cue: SpeechCue, at: number) => void;

/** A line on stage, waiting for every on-air stage that got it to finish. */
interface Playback {
  cue: SpeechCue;
  /** On-air stages still playing it. */
  pending: Set<string>;
  /** Moves the deadline (a stage started the line and told us how long it really is). */
  rearm(ms: number): void;
  done(): void;
}

/**
 * The channel's link to its stage clients (OBS sources, previews, the cloud
 * broadcaster). Lives as long as the channel has connections or a running
 * runtime, so OBS stays connected (showing the idle character) while the
 * host is stopped.
 */
export class StageHub implements SpeechOutput, StageNotifier {
  private readonly peers = new Map<string, StagePeer>();
  private readonly playing = new Map<string, Playback>();
  private lastSegment: Segment | undefined;
  private lastStats: { viewers: number; likes: number } | undefined;
  private statsSentAt = 0;
  private statsTimer: ReturnType<typeof setTimeout> | undefined;
  private telemetry: EngineTelemetry | null = null;
  private cueListener: CueListener | null = null;
  private readonly now: () => number;

  constructor(private readonly options: StageHubOptions) {
    this.now = options.now ?? Date.now;
  }

  attach(peer: Peer, role: StageRole): void {
    this.peers.set(peer.id, { peer, role });
    this.sendTo(peer, {
      t: "hello",
      serverTime: this.now(),
      name: this.options.name,
      look: this.options.look,
      disclosure: disclosureText(this.options.name),
    });
    if (this.lastSegment) this.sendTo(peer, { t: "segment", title: this.lastSegment.title });
    if (this.lastStats) this.sendTo(peer, { t: "stats", ...this.lastStats });
    this.options.log?.debug(`${role} stage connected`);
  }

  detach(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.peers.delete(peerId);
    // A stage that left can't finish its lines; don't wait for it.
    for (const playback of [...this.playing.values()]) this.settle(playback, peerId);
    this.options.log?.debug(`${entry.role} stage disconnected`);
  }

  handleMessage(peerId: string, raw: unknown): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    const message = parseMessage(stageClientMessageSchema, raw);
    if (!message) return;
    switch (message.t) {
      case "ready":
        entry.role = message.role;
        break;
      case "started": {
        const playback = this.playing.get(message.id);
        if (playback?.pending.has(peerId)) playback.rearm((message.durationMs || playback.cue.durationMs) + END_GRACE_MS);
        break;
      }
      case "spoken": {
        // Only stages that are really on air pace the host; previews don't.
        const playback = this.playing.get(message.id);
        if (playback) this.settle(playback, peerId);
        break;
      }
      case "telemetry":
        if (entry.role !== "preview") {
          this.telemetry = {
            fps: message.fps,
            frameP95: message.frameP95,
            quality: message.quality,
            renderer: message.renderer ?? null,
            error: message.error ?? null,
            at: this.now(),
          };
        }
        break;
    }
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  counts(): { program: number; preview: number; broadcast: number } {
    const out = { program: 0, preview: 0, broadcast: 0 };
    for (const { role } of this.peers.values()) out[role] += 1;
    return out;
  }

  engineTelemetry(): EngineTelemetry | null {
    if (!this.telemetry || this.now() - this.telemetry.at > 60_000) return null;
    return this.telemetry;
  }

  /** Persona name or look changed: stages morph to the new look without reloading. */
  setLook(name: string, look: Look): void {
    this.options.name = name;
    this.options.look = look;
    this.broadcast({ t: "look", name, look });
  }

  /** The running runtime listens for outgoing cues to measure latency. */
  setCueListener(listener: CueListener | null): void {
    this.cueListener = listener;
  }

  get stageKey(): string {
    return this.options.stageKey;
  }

  setStageKey(stageKey: string): void {
    this.options.stageKey = stageKey;
  }

  /** Tells stages the server is going away; they keep the last frame and reconnect. */
  hold(): void {
    this.broadcast({ t: "hold" });
  }

  closeAll(code = 1001, reason = "channel removed"): void {
    clearTimeout(this.statsTimer);
    this.statsTimer = undefined;
    for (const { peer } of this.peers.values()) peer.close(code, reason);
    this.peers.clear();
  }

  // ---- SpeechOutput -------------------------------------------------------

  prefetch(cue: SpeechCue): void {
    const audioUrl = this.audioUrlFor(cue);
    if (audioUrl) this.broadcast({ t: "prefetch", audioUrl });
  }

  /**
   * Sends a line and resolves once every on-air stage that got it finished
   * it (ADR-0022): the show never runs ahead of the slowest stage on air, so
   * no stage has a sentence cut short by the next one. A stage that stalls
   * is waited for until the line should have ended plus a grace period.
   */
  play(cue: SpeechCue, signal: AbortSignal): Promise<void> {
    const audioUrl = this.audioUrlFor(cue);
    this.broadcast({ t: "speak", id: cue.id, text: cue.text, emotion: cue.emotion, audioUrl, durationMs: cue.durationMs });
    this.cueListener?.(cue, this.now());

    const onAir = [...this.peers].filter(([, entry]) => entry.role !== "preview").map(([id]) => id);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const playback: Playback = {
        cue,
        pending: new Set(onAir),
        rearm: (ms) => {
          clearTimeout(timer);
          timer = setTimeout(playback.done, ms);
        },
        done: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", playback.done);
          if (this.playing.get(cue.id) === playback) this.playing.delete(cue.id);
          resolve();
        },
      };
      // With no on-air stage connected (e.g. OBS not open yet), pace speech by
      // its estimated duration so the show's rhythm stays realistic.
      playback.rearm(onAir.length > 0 ? cue.durationMs + START_GRACE_MS : cue.durationMs);
      signal.addEventListener("abort", playback.done, { once: true });
      this.playing.set(cue.id, playback);
    });
  }

  interrupt(): void {
    this.broadcast({ t: "stop" });
    for (const playback of [...this.playing.values()]) playback.done();
  }

  private settle(playback: Playback, peerId: string): void {
    if (!playback.pending.delete(peerId)) return;
    if (playback.pending.size === 0) playback.done();
  }

  private audioUrlFor(cue: SpeechCue): string | null {
    if (!cue.audio) return null;
    this.options.audio.put(this.options.channelId, cue.id, cue.audio);
    return `/api/stage/${this.options.stageKey}/audio/${cue.id}`;
  }

  // ---- StageNotifier ------------------------------------------------------

  alert(event: LiveEvent): void {
    if (!("viewer" in event)) return;
    const name = event.viewer.nickname || event.viewer.handle;
    if (event.kind === "gift") {
      this.broadcast({ t: "alert", kind: "gift", name, giftName: event.giftName, count: event.count, diamonds: event.diamonds });
    } else if (event.kind === "follow" || event.kind === "share") {
      this.broadcast({ t: "alert", kind: event.kind, name });
    }
  }

  segment(segment: Segment): void {
    this.lastSegment = segment;
    this.broadcast({ t: "segment", title: segment.title });
  }

  /** Coalesced: a like storm becomes at most a few stats messages a second. */
  stats(stats: { viewers: number; likes: number }): void {
    this.lastStats = stats;
    if (this.statsTimer) return;
    const send = () => {
      this.statsTimer = undefined;
      this.statsSentAt = this.now();
      if (this.lastStats) this.broadcast({ t: "stats", ...this.lastStats });
    };
    const wait = this.statsSentAt + STATS_INTERVAL_MS - this.now();
    if (wait <= 0) send();
    else this.statsTimer = setTimeout(send, wait);
  }

  // ---- internals ----------------------------------------------------------

  private broadcast(payload: StageServerPayload): void {
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...payload });
    const droppable = payload.t === "stats";
    for (const { peer } of this.peers.values()) {
      if (droppable && peer.bufferedAmount() > BACKPRESSURE_BYTES) continue;
      peer.send(data);
    }
  }

  private sendTo(peer: Peer, payload: StageServerPayload): void {
    peer.send(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  }
}

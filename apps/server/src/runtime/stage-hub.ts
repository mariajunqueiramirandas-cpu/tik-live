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

/** Extra time a stage gets past the cue's estimated duration before we move on anyway. */
const PLAYBACK_GRACE_MS = 4_000;

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

/**
 * The channel's link to its stage clients (OBS sources, previews, the cloud
 * broadcaster). Lives as long as the channel has connections or a running
 * runtime, so OBS stays connected (showing the idle character) while the
 * host is stopped.
 */
export class StageHub implements SpeechOutput, StageNotifier {
  private readonly peers = new Map<string, StagePeer>();
  /** Cues sent to the stages, in playing order: a mirror of their queues. The first is playing. */
  private outstanding: Array<{ cue: SpeechCue; resolve: () => void }> = [];
  private headTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSegment: Segment | undefined;
  private lastStats: { viewers: number; likes: number } | undefined;
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
      case "spoken":
        // Only stages that are really on air pace the host; previews don't.
        if (entry.role !== "preview") this.finish(message.id);
        break;
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
    for (const { peer } of this.peers.values()) peer.close(code, reason);
    this.peers.clear();
  }

  // ---- SpeechOutput -------------------------------------------------------

  /**
   * Queues a cue on every stage (ADR-0022). Stages play cues back to back in
   * the order sent, so a cue sent while another plays waits its turn instead
   * of cutting it off. Resolves when an on-air stage reports it spoken, or,
   * as a fallback, once its duration (plus grace, if a stage should have
   * answered) has passed since it reached the front of the queue.
   */
  play(cue: SpeechCue): Promise<void> {
    const audioUrl = this.audioUrlFor(cue);
    this.broadcast({
      t: "cue",
      id: cue.id,
      text: cue.text,
      emotion: cue.emotion,
      audioUrl,
      durationMs: cue.durationMs,
      ...(cue.audio?.words ? { words: cue.audio.words } : {}),
    });
    return new Promise((resolve) => {
      this.outstanding.push({ cue, resolve });
      if (this.outstanding.length === 1) this.startHead();
    });
  }

  drop(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const head = this.outstanding[0];
    const dropped = this.outstanding.filter((entry) => entry !== head && ids.includes(entry.cue.id));
    if (dropped.length === 0) return;
    this.outstanding = this.outstanding.filter((entry) => !dropped.includes(entry));
    this.broadcast({ t: "drop", ids: dropped.map((entry) => entry.cue.id) });
    for (const entry of dropped) entry.resolve();
  }

  interrupt(): void {
    this.broadcast({ t: "stop" });
    clearTimeout(this.headTimer);
    const all = this.outstanding;
    this.outstanding = [];
    for (const entry of all) entry.resolve();
  }

  /** The cue at the front of the queue starts playing now (as far as the server can tell). */
  private startHead(): void {
    clearTimeout(this.headTimer);
    const head = this.outstanding[0];
    if (!head) return;
    this.cueListener?.(head.cue, this.now());
    // With no on-air stage connected (e.g. OBS not open yet), pace speech by
    // its estimated duration so the show's rhythm stays realistic.
    const { program, broadcast } = this.counts();
    const timeoutMs = program + broadcast > 0 ? head.cue.durationMs + PLAYBACK_GRACE_MS : head.cue.durationMs;
    this.headTimer = setTimeout(() => this.finish(head.cue.id), timeoutMs);
  }

  /** A cue finished. Stages play in order, so every cue before it is over too. */
  private finish(id: string): void {
    const index = this.outstanding.findIndex((entry) => entry.cue.id === id);
    if (index === -1) return;
    const done = this.outstanding.splice(0, index + 1);
    for (const entry of done) entry.resolve();
    this.startHead();
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

  stats(stats: { viewers: number; likes: number }): void {
    this.lastStats = stats;
    this.broadcast({ t: "stats", ...stats });
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

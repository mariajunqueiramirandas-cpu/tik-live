import type { Emotion, Look, StageServerPayload } from "@tik-live/shared";
import { AudioEngine } from "../src/audio/audio";
import type { EngineEvents, EngineMode, StageEngine, Telemetry } from "../src/engine";

/** Records what the page would have rendered. */
export class FakeEngine implements StageEngine {
  readonly audio = new AudioEngine();
  readonly applied: StageServerPayload[] = [];
  readonly listeners: { [K in keyof EngineEvents]: Set<EngineEvents[K]> } = { spoken: new Set(), telemetry: new Set() };
  failed: string | null = null;
  autoSpeak = true;

  constructor(readonly mode: EngineMode = "program") {}

  apply(message: StageServerPayload): void {
    this.applied.push(message);
    if ((message.t === "speak" || message.t === "cue") && this.autoSpeak) queueMicrotask(() => this.emit("spoken", message.id));
  }
  setLook(_name: string, _look: Look): void {}
  setEmotion(_emotion: Emotion): void {}
  renderAt(): void {}
  telemetry(): Telemetry {
    return { fps: 60, frameP95: 2.5, quality: 0, renderer: "fake", error: null };
  }
  on<K extends keyof EngineEvents>(event: K, listener: EngineEvents[K]): () => void {
    const set = this.listeners[event] as Set<EngineEvents[K]>;
    set.add(listener);
    return () => set.delete(listener);
  }
  emit<K extends keyof EngineEvents>(event: K, ...args: Parameters<EngineEvents[K]>): void {
    for (const l of this.listeners[event] as Set<(...a: Parameters<EngineEvents[K]>) => void>) l(...args);
  }
  resize(): void {}
  destroy(): void {}
}

/** A scriptable WebSocket stand-in. */
export class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  readonly sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.readyState = 3;
  }

  // Test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

/** Manual timers for reconnect scheduling. */
export class FakeTimers {
  readonly pending: Array<{ fn: () => void; ms: number; id: number }> = [];
  private next = 1;
  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.next++;
    this.pending.push({ fn, ms, id });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    const i = this.pending.findIndex((p) => p.id === handle);
    if (i >= 0) this.pending.splice(i, 1);
  };
  runNext(): number {
    const item = this.pending.shift();
    item?.fn();
    return item?.ms ?? -1;
  }
}

import {
  PROTOCOL_VERSION,
  type LiveEventSummary,
  type RuntimeSnapshot,
  type StudioCommand,
  type StudioServerMessage,
  type TranscriptLine,
} from "@tik-live/shared";
import { useEffect, useMemo, useSyncExternalStore } from "react";

/**
 * The studio's live state (ADR-0010): one WebSocket per open channel,
 * a full snapshot on (re)connect, coalesced patches after that. Components
 * subscribe to slices through `useStudio(store, selector)`, so a stats tick
 * doesn't re-render the room.
 */
export type RoomItem =
  | { kind: "line"; key: string; at: number; line: TranscriptLine }
  | { kind: "event"; key: string; at: number; event: LiveEventSummary };

export interface Notice {
  id: string;
  level: "info" | "warn" | "error";
  code: string;
  message: string;
  at: number;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export interface StudioState {
  connection: ConnectionState;
  snapshot: RuntimeSnapshot | null;
  room: RoomItem[];
  notices: Notice[];
}

export interface CommandResult {
  ok: boolean;
  error?: string;
}

const ROOM_LIMIT = 300;
const COMMAND_TIMEOUT_MS = 8000;

export class StudioStore {
  private state: StudioState = { connection: "connecting", snapshot: null, room: [], notices: [] };
  private readonly listeners = new Set<() => void>();
  private socket: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly pending = new Map<string, { resolve: (r: CommandResult) => void; rollback?: () => void; timer: ReturnType<typeof setTimeout> }>();
  private refs = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly channelId: string) {}

  // ---- external store -------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): StudioState => this.state;

  private set(patch: Partial<StudioState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  // ---- lifecycle --------------------------------------------------------------

  retain(): void {
    this.refs += 1;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.closed || (!this.socket && !this.timer)) {
      this.closed = false;
      this.connect();
    }
  }

  /**
   * Closes the socket shortly after the last user leaves, so remounts
   * (StrictMode, switching tabs within a host) reuse the connection.
   */
  release(): void {
    this.refs -= 1;
    if (this.refs > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.refs > 0) return;
      this.closed = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      const ws = this.socket;
      this.socket = null;
      ws?.close(1000);
      this.set({ connection: "closed" });
    }, 2000);
  }

  private connect(): void {
    this.timer = null;
    if (this.closed) return;
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/ws/studio/${encodeURIComponent(this.channelId)}`);
    this.socket = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.set({ connection: "open" });
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        this.handle(JSON.parse(event.data) as StudioServerMessage);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (this.socket !== ws) return;
      this.socket = null;
      for (const [id, entry] of this.pending) this.settle(id, { ok: false, error: "A conexão caiu antes de o apresentador confirmar." }, entry);
      if (this.closed) return this.set({ connection: "closed" });
      this.set({ connection: "reconnecting" });
      const ceiling = Math.min(10_000, 500 * 2 ** this.attempt++);
      this.timer = setTimeout(() => this.connect(), ceiling * (0.5 + Math.random() * 0.5));
    };
  }

  private handle(message: StudioServerMessage): void {
    switch (message.t) {
      case "snapshot":
        this.set({ snapshot: message.state });
        break;
      case "patch":
        if (this.state.snapshot) this.set({ snapshot: { ...this.state.snapshot, ...message.state } });
        break;
      case "history": {
        const items: RoomItem[] = [
          ...message.transcript.map((line) => lineItem(line)),
          ...message.events.map((event) => eventItem(event)),
        ].sort((a, b) => a.at - b.at);
        this.set({ room: items.slice(-ROOM_LIMIT) });
        break;
      }
      case "transcript":
        this.append(lineItem(message.line));
        break;
      case "live-event":
        this.append(eventItem(message.event));
        break;
      case "notice": {
        const notice: Notice = { id: `${message.code}-${message.at}`, level: message.level, code: message.code, message: message.message, at: message.at };
        this.set({ notices: [...this.state.notices.filter((n) => n.code !== notice.code), notice].slice(-5) });
        break;
      }
      case "ack": {
        const entry = this.pending.get(message.id);
        if (entry) this.settle(message.id, message.ok ? { ok: true } : { ok: false, error: message.error ?? "O apresentador não aceitou o comando." }, entry);
        break;
      }
      case "log":
        break;
    }
  }

  private append(item: RoomItem): void {
    const room = this.state.room;
    if (room.some((r) => r.key === item.key)) return;
    const next = room.length >= ROOM_LIMIT ? room.slice(room.length - ROOM_LIMIT + 1) : room.slice();
    // Usually newest; insert in time order if something arrives late.
    let i = next.length;
    while (i > 0 && (next[i - 1] as RoomItem).at > item.at) i--;
    next.splice(i, 0, item);
    this.set({ room: next });
  }

  dismissNotice(id: string): void {
    this.set({ notices: this.state.notices.filter((n) => n.id !== id) });
  }

  // ---- commands ---------------------------------------------------------------

  /**
   * Sends a command. `optimistic` patches the snapshot right away and is
   * rolled back if the host rejects it or doesn't answer in time.
   */
  command(command: StudioCommand, optimistic?: Partial<RuntimeSnapshot>): Promise<CommandResult> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, error: "Sem conexão com o apresentador agora. Reconectando…" });
    }
    const id = crypto.randomUUID();
    let rollback: (() => void) | undefined;
    if (optimistic && this.state.snapshot) {
      const before = this.state.snapshot;
      const keys = Object.keys(optimistic) as Array<keyof RuntimeSnapshot>;
      const previous = Object.fromEntries(keys.map((k) => [k, before[k]])) as Partial<RuntimeSnapshot>;
      this.set({ snapshot: { ...before, ...optimistic } });
      rollback = () => {
        if (this.state.snapshot) this.set({ snapshot: { ...this.state.snapshot, ...previous } });
      };
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) this.settle(id, { ok: false, error: "O apresentador não respondeu. Tente de novo." }, entry);
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, ...(rollback ? { rollback } : {}), timer });
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "command", id, command }));
    });
  }

  private settle(id: string, result: CommandResult, entry: { resolve: (r: CommandResult) => void; rollback?: () => void; timer: ReturnType<typeof setTimeout> }): void {
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (!result.ok) entry.rollback?.();
    entry.resolve(result);
  }
}

function lineItem(line: TranscriptLine): RoomItem {
  return { kind: "line", key: `l:${line.id}`, at: line.at, line };
}

function eventItem(event: LiveEventSummary): RoomItem {
  return { kind: "event", key: `e:${event.id}`, at: event.at, event };
}

// ---- React bindings -------------------------------------------------------------

const stores = new Map<string, StudioStore>();

/** One shared store per channel, connected while any component uses it. */
export function useStudioStore(channelId: string): StudioStore {
  const store = useMemo(() => {
    let existing = stores.get(channelId);
    if (!existing) {
      existing = new StudioStore(channelId);
      stores.set(channelId, existing);
    }
    return existing;
  }, [channelId]);
  useEffect(() => {
    store.retain();
    return () => store.release();
  }, [store]);
  return store;
}

export function useStudio<T>(store: StudioStore, select: (state: StudioState) => T): T {
  return useSyncExternalStore(store.subscribe, () => select(store.getState()), () => select(store.getState()));
}

import type { Server, ServerWebSocket } from "bun";
import { LIVE_STUDIO_ACTIONS, LIVE_STUDIO_SUBPROTOCOL } from "../src/broadcast";

interface MockScene {
  name: string;
  sources: Array<{ id: string; label: string; visible: boolean }>;
}

export interface MockStudioState {
  stream_status: number;
  recording: boolean;
  highlight_able: boolean;
  scene: string;
  scenes: MockScene[];
  vibes: Array<{ id: string; name: string }>;
  playingVibe: string;
  cameraCategories: Array<{ key: string; name: string; effects: Array<{ label: string; value: string }> }>;
}

interface Client {
  /** Studio registers its event handlers once per join, without removing earlier ones. */
  handlers: number;
}

/**
 * A stand-in for TikTok LIVE Studio's Stream Deck server, with the quirks
 * that matter (docs/live-studio/stream-deck-protocol.md):
 * - each `join_room` adds another set of handlers, so a socket that joins
 *   twice runs every action twice; `leave_room` removes them;
 * - any client disconnecting stops change pushes for everyone, until a join;
 * - a sync request that arrives before the join's handlers exist is lost,
 *   and while starting up Studio answers with an empty snapshot;
 * - in token mode the namespace connect is refused with `44`.
 */
export class MockLiveStudio {
  readonly state: MockStudioState = {
    stream_status: 0,
    recording: false,
    highlight_able: true,
    scene: "Cena 1",
    scenes: [
      { name: "Cena 1", sources: [{ id: "src-1", label: "Vincular", visible: true }] },
      { name: "Câmera em tela cheia", sources: [{ id: "src-2", label: "Câmera", visible: true }] },
    ],
    vibes: [
      { id: "vibe-win", name: "Vitória!" },
      { id: "vibe-roast", name: "Essa doeu!" },
    ],
    playingVibe: "",
    cameraCategories: [{ key: "popular", name: "Populares", effects: [{ label: "Brilho", value: "fx-1" }] }],
  };
  /** Every action Studio ran, duplicates included. */
  readonly actions: Array<{ action: string; payload: Record<string, unknown> }> = [];
  connections = 0;
  /** Refuse the namespace connect, like Studio with Stream Deck token auth switched on. */
  authRequired = false;
  /** Studio isn't on its main page: it answers nothing. */
  mainPage = true;
  /** Empty snapshots to send before real ones, like Studio while it starts. */
  emptySnapshots = 0;
  /** What pressing start does: go live at once, after a delay, or nothing (Studio accepted the press but the live didn't start). */
  liveStart: "now" | "never" | number = "now";
  listening = true;
  private readonly clients = new Map<ServerWebSocket<Client>, Client>();
  private readonly server: Server<Client>;

  constructor() {
    this.server = Bun.serve<Client>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req, srv) => {
        const protocol = req.headers.get("sec-websocket-protocol");
        if (srv.upgrade(req, { data: { handlers: 0 }, ...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol.split(",")[0]!.trim() } } : {}) })) {
          return undefined;
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open: (ws) => {
          this.connections += 1;
          ws.send('0{"sid":"mock","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
        },
        message: (ws, message) => this.handle(ws, String(message)),
        close: (ws) => {
          this.clients.delete(ws);
          // Studio's disconnect hook: stopListening() for everyone.
          this.listening = false;
        },
      },
    });
  }

  get port(): number {
    return this.server.port!;
  }

  stop(): void {
    this.server.stop(true);
  }

  /** Changes state inside Studio (as a person clicking in the app would) and pushes it if Studio is listening. */
  change(patch: Partial<MockStudioState>): void {
    Object.assign(this.state, patch);
    if (this.listening) this.broadcastSnapshot();
  }

  snapshot(): Record<string, unknown> {
    const sceneList = this.state.scenes.map((scene) => ({
      name: scene.name,
      sources: scene.sources.map((s) => ({ label: s.label, value: s.id })),
      visible_sources: scene.sources.filter((s) => s.visible).map((s) => ({ label: s.label, value: s.id })),
    }));
    return {
      stream_status: this.state.stream_status,
      recording: this.state.recording,
      highlight_able: this.state.highlight_able,
      scene: this.state.scene,
      scene_list: sceneList,
      vibeList: this.state.vibes,
      playingVibe: this.state.playingVibe,
      camera_effect: {
        sourceList: [
          { label: "Todas", value: "all" },
          { label: "Padrão", value: "default", isDefault: true },
        ],
        typeList: this.state.cameraCategories.map((c) => c.name),
        effectList: this.state.cameraCategories.map((c) => ({ key: c.key, name: c.name, effects: c.effects })),
      },
    };
  }

  private emit(ws: ServerWebSocket<Client>, event: string, payload?: string): void {
    ws.send(`42${JSON.stringify(payload === undefined ? [event] : [event, payload])}`);
  }

  private broadcastSnapshot(): void {
    if (!this.mainPage) return;
    const payload = JSON.stringify(this.snapshot());
    for (const ws of this.clients.keys()) this.emit(ws, "stream_deck/sync_settings", payload);
  }

  private handle(ws: ServerWebSocket<Client>, text: string): void {
    if (text === "40") {
      if (this.authRequired) {
        ws.send('44{"message":"invalid"}');
        return;
      }
      ws.send('40{"sid":"mock-room"}');
      return;
    }
    if (!text.startsWith("42")) return;
    const [event, raw] = JSON.parse(text.slice(2)) as [string, string | undefined];
    const client = ws.data;
    if (event === "stream_deck/join_room") {
      client.handlers += 1;
      this.clients.set(ws, client);
      this.listening = true;
      return;
    }
    if (event === "stream_deck/leave_room") {
      client.handlers = 0;
      this.clients.delete(ws);
      return;
    }
    if (client.handlers === 0 || !this.mainPage) return;
    if (event === "stream_deck/sync_settings") {
      if (this.emptySnapshots > 0) {
        this.emptySnapshots -= 1;
        for (const other of this.clients.keys()) this.emit(other, "stream_deck/sync_settings");
        return;
      }
      this.broadcastSnapshot();
      return;
    }
    if (event === "stream_deck/action_emit" && raw) {
      const { action, context, payload } = JSON.parse(raw) as { action: string; context: string; payload: Record<string, unknown> };
      for (let i = 0; i < client.handlers; i++) {
        const code = this.run(action, payload ?? {});
        for (const other of this.clients.keys()) this.emit(other, `stream_deck/${context}`, JSON.stringify({ code }));
      }
    }
  }

  private run(action: string, payload: Record<string, unknown>): number {
    this.actions.push({ action, payload });
    const settings = (payload.settings ?? {}) as Record<string, string | undefined>;
    switch (action) {
      case LIVE_STUDIO_ACTIONS.liveStartEnd:
        if (this.state.stream_status === 0) {
          if (this.liveStart === "now") this.change({ stream_status: 2 });
          else if (typeof this.liveStart === "number") setTimeout(() => this.change({ stream_status: 2 }), this.liveStart);
        } else {
          this.change({ stream_status: 0 });
        }
        return 0;
      case LIVE_STUDIO_ACTIONS.livePauseResume:
        if (this.state.stream_status === 0) return -1;
        this.change({ stream_status: this.state.stream_status === 1 ? 2 : 1 });
        return 0;
      case LIVE_STUDIO_ACTIONS.highlight:
        return this.state.highlight_able ? 0 : -1;
      case LIVE_STUDIO_ACTIONS.recording:
        this.change({ recording: !this.state.recording });
        return 0;
      case LIVE_STUDIO_ACTIONS.scene: {
        if (!this.state.scenes.some((s) => s.name === settings.scene)) return -1;
        this.change({ scene: settings.scene! });
        return 0;
      }
      case LIVE_STUDIO_ACTIONS.source: {
        if (settings.scene !== this.state.scene) return -1;
        const source = this.state.scenes.find((s) => s.name === settings.scene)?.sources.find((s) => s.id === settings.source);
        if (!source) return -1;
        source.visible = !source.visible;
        this.change({});
        return 0;
      }
      case LIVE_STUDIO_ACTIONS.vibe:
        if (!settings.currentVibeId) return -1;
        this.change({ playingVibe: settings.currentVibeId });
        return 0;
      case LIVE_STUDIO_ACTIONS.cameraEffects: {
        // Studio looks the category up by name.
        const category = this.state.cameraCategories.find((c) => c.name === settings.cameraEffectType);
        return category?.effects.some((e) => e.value === settings.cameraEffectId) ? 0 : -1;
      }
      default:
        return -1;
    }
  }
}

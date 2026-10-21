import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fitLiveStudioProbe, LIVE_STUDIO_ACTIONS, LIVE_STUDIO_SUBPROTOCOL, type LiveStudioProbe } from "../src/broadcast";
import {
  AUTH_REQUIRED_DETAIL,
  injectStageIntoTikTokStore,
  isTcpPortOpen,
  LocalLiveStudioController,
  readLocalTikTokStore,
  type LiveStudioTimings,
  type StudioSystem,
} from "../src/live-studio";
import { MockLiveStudio } from "./mock-live-studio";

const FAST: Partial<LiveStudioTimings> = { firstSnapshotMs: 1_500, startWaitMs: 1_000, stopWaitMs: 500, launchMs: 2_000 };

/** A PC where Studio may or may not be running, and nothing gets launched for real. */
function fakeSystem(overrides: Partial<StudioSystem> & { running?: boolean } = {}): StudioSystem & { launched: string[]; running: boolean } {
  const system = {
    launched: [] as string[],
    running: overrides.running ?? false,
    isStudioRunning: async () => system.running,
    studioPorts: overrides.studioPorts ?? (async () => []),
    isPortOpen: overrides.isPortOpen ?? ((host: string, port: number) => isTcpPortOpen(host, port)),
    launch(executablePath: string) {
      system.launched.push(executablePath);
    },
  };
  return system;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function studio(): MockLiveStudio {
  const mock = new MockLiveStudio();
  cleanup.push(() => mock.stop());
  return mock;
}

function controllerFor(
  mock: MockLiveStudio | null,
  options: { system?: StudioSystem; timings?: Partial<LiveStudioTimings>; ports?: number[]; ttStoreDir?: string | null } = {},
): LocalLiveStudioController {
  const controller = new LocalLiveStudioController({
    ports: options.ports ?? (mock ? [mock.port] : []),
    executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
    ttStoreDir: options.ttStoreDir ?? null,
    system: options.system ?? fakeSystem(),
    timings: { ...FAST, ...options.timings },
  });
  cleanup.push(() => controller.close());
  return controller;
}

describe("LocalLiveStudioController", () => {
  it("reads Studio's state and runs every command over one socket", async () => {
    const mock = studio();
    const controller = controllerFor(mock);

    const probe = await controller.probe();
    expect(probe).toMatchObject({ connected: true, running: true, streamStatus: "stopped", scene: "Cena 1", highlightAble: true });
    expect(probe.vibeList).toEqual(mock.state.vibes);

    expect(await controller.start()).toEqual({ ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" });
    expect((await controller.probe()).streamStatus).toBe("live");
    // Already live: start doesn't press the toggle again.
    expect((await controller.start()).ok).toBe(true);

    expect((await controller.highlight()).ok).toBe(true);
    expect((await controller.toggleRecording()).ok).toBe(true);
    expect((await controller.probe()).recording).toBe(true);
    expect((await controller.switchScene("Câmera em tela cheia")).ok).toBe(true);
    expect((await controller.probe()).scene).toBe("Câmera em tela cheia");
    expect((await controller.toggleSource("src-2")).ok).toBe(true);
    expect((await controller.triggerVibe("Vitória!")).ok).toBe(true);
    expect((await controller.probe()).playingVibe).toBe("vibe-win");
    expect((await controller.stop()).ok).toBe(true);
    expect((await controller.probe()).streamStatus).toBe("stopped");

    expect(mock.connections).toBe(1);
    expect(mock.actions.filter((a) => a.action === LIVE_STUDIO_ACTIONS.liveStartEnd)).toHaveLength(2);
  });

  it("sends the camera effect category by name, even when given its key", async () => {
    const mock = studio();
    const controller = controllerFor(mock);
    expect((await controller.setCameraEffect({ cameraEffectType: "popular", cameraEffectId: "fx-1" })).ok).toBe(true);
    expect(mock.actions.at(-1)?.payload).toEqual({ settings: { cameraSource: "default", cameraEffectType: "Populares", cameraEffectId: "fx-1" } });
    expect((await controller.setCameraEffect({ cameraEffectType: "nope", cameraEffectId: "fx-1" })).ok).toBe(false);
  });

  it("only toggles sources of the current scene", async () => {
    const mock = studio();
    const controller = controllerFor(mock);
    const result = await controller.toggleSource("src-2", "Câmera em tela cheia");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("cena atual");
    expect(mock.actions).toHaveLength(0);
  });

  it("refuses a highlight while Studio doesn't allow one", async () => {
    const mock = studio();
    mock.state.highlight_able = false;
    const controller = controllerFor(mock);
    expect((await controller.highlight()).detail).toContain("live no ar");
    expect(mock.actions).toHaveLength(0);
  });

  it("re-joins by leaving first, so Studio never runs an action twice, and recovers pushes another client stopped", async () => {
    const mock = studio();
    const controller = controllerFor(mock, { timings: { rejoinMs: 50 } });
    expect((await controller.probe()).scene).toBe("Cena 1");

    // Another client (a Stream Deck) comes and goes: Studio stops pushing changes to everyone.
    const other = new WebSocket(`ws://127.0.0.1:${mock.port}/socket.io/?EIO=4&transport=websocket`, [LIVE_STUDIO_SUBPROTOCOL]);
    await new Promise<void>((resolve) => other.addEventListener("open", () => resolve()));
    other.send("40");
    other.send('42["stream_deck/join_room"]');
    await Bun.sleep(50);
    other.close();
    await Bun.sleep(100);
    mock.change({ scene: "Câmera em tela cheia" });
    expect(mock.listening).toBe(false);

    await Bun.sleep(60);
    expect((await controller.probe()).scene).toBe("Câmera em tela cheia");
    expect(mock.listening).toBe(true);

    await Bun.sleep(60);
    await controller.probe();
    expect((await controller.switchScene("Cena 1")).ok).toBe(true);
    expect(mock.actions.filter((a) => a.action === LIVE_STUDIO_ACTIONS.scene)).toHaveLength(1);
  });

  it("waits out Studio's empty snapshots while it starts up", async () => {
    const mock = studio();
    mock.emptySnapshots = 1;
    const controller = controllerFor(mock, { timings: { firstSnapshotMs: 2_500 } });
    expect((await controller.probe()).connected).toBe(true);
  });

  it("says when Studio refuses the connection, and doesn't try to open it again", async () => {
    const mock = studio();
    mock.authRequired = true;
    const system = fakeSystem();
    const controller = controllerFor(mock, { system });
    const probe = await controller.probe();
    expect(probe).toMatchObject({ connected: false, running: true, authRequired: true });
    expect(await controller.start()).toEqual({ ok: false, detail: AUTH_REQUIRED_DETAIL });
    expect(system.launched).toEqual([]);
  });

  it("finds Studio on a port outside its usual list", async () => {
    const mock = studio();
    const controller = controllerFor(mock, { ports: [1], system: fakeSystem({ studioPorts: async () => [mock.port] }) });
    expect(await controller.probe()).toMatchObject({ connected: true, port: mock.port });
  });

  it("doesn't open a second Studio while one is running but not answering, nor call its live ended", async () => {
    const mock = studio();
    mock.mainPage = false;
    const system = fakeSystem();
    const controller = controllerFor(mock, { system });
    expect(await controller.probe()).toMatchObject({ connected: false, running: true });
    expect((await controller.launch()).ok).toBe(false);
    expect(system.launched).toEqual([]);
    const stopped = await controller.stop();
    expect(stopped.ok).toBe(false);
    expect(mock.actions).toHaveLength(0);
  }, 15_000);

  it("opens Studio only when it isn't running, and calls a closed Studio's live ended", async () => {
    const system = fakeSystem({ running: false });
    const controller = controllerFor(null, { system });
    expect(await controller.probe()).toMatchObject({ connected: false, running: false });
    expect(await controller.stop()).toEqual({ ok: true, detail: "Desligada" });
    await controller.launch();
    expect(system.launched).toHaveLength(1);
  });

  it("presses start once when Studio accepts it but the live is slow, and lets a stop cancel the wait", async () => {
    const mock = studio();
    mock.liveStart = "never";
    const controller = controllerFor(mock, { timings: { startWaitMs: 5_000 } });
    const starting = controller.start();
    await Bun.sleep(300);
    const stopping = controller.stop();
    const started = await starting;
    expect(started.ok).toBe(false);
    expect(started.detail).toContain("cancelado");
    expect((await stopping).ok).toBe(true);
    expect(mock.actions.filter((a) => a.action === LIVE_STUDIO_ACTIONS.liveStartEnd)).toHaveLength(1);
  });

  it("reports a live that starts a little after the press", async () => {
    const mock = studio();
    mock.liveStart = 300;
    const controller = controllerFor(mock);
    expect((await controller.start()).ok).toBe(true);
    expect(mock.actions.filter((a) => a.action === LIVE_STUDIO_ACTIONS.liveStartEnd)).toHaveLength(1);
  });

  it("tells the agent when Studio's state changes", async () => {
    const mock = studio();
    const controller = controllerFor(mock);
    await controller.probe();
    let changes = 0;
    controller.onChange(() => {
      changes += 1;
    });
    mock.change({ recording: true });
    await Bun.sleep(50);
    expect(changes).toBeGreaterThan(0);
  });
});

describe("TikTok LIVE Studio scene file", () => {
  const sceneId = "f9d3a8fc-1463-47c7-91f5-e6441262639e";

  function storeDir(extraSources: Record<string, unknown> = {}): string {
    const dir = mkdtempSync(path.join(tmpdir(), "lantern-ttstore-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = {
      UserService: { state: { userInfo: { username: "curiosabolha", display_id: "curiosabolha" } }, version: 1 },
      SourceService: {
        state: {
          currentSceneNew: sceneId,
          scenes: [{ id: sceneId, name: "Câmera em tela cheia" }],
          sceneSource: {
            [sceneId]: {
              order: ["src-1", ...Object.keys(extraSources)],
              data: { "src-1": { id: "src-1", name: "Adesivo", type: "rankingSticker", visible: true }, ...extraSources },
              theme: "Default",
            },
          },
        },
        version: 1,
      },
    };
    writeFileSync(path.join(dir, "services.json"), JSON.stringify(store, null, 2), "utf8");
    return dir;
  }

  function browserSources(dir: string) {
    const saved = JSON.parse(readFileSync(path.join(dir, "services.json"), "utf8"));
    return (Object.values(saved.SourceService.state.sceneSource[sceneId].data) as Array<{ name: string; type: string; visible: boolean; payload?: { url?: string } }>).filter(
      (s) => s.type === "browser",
    );
  }

  it("adds the stage source, keeps a backup, and updates it in place when the stage key changes", () => {
    const dir = storeDir();
    expect(readLocalTikTokStore(dir)).toEqual({ tiktokUsername: "curiosabolha", stageInjected: false, stageSourceUrl: null });

    const stageUrl = "http://localhost:8080/s/abcdefgh12345678";
    const injected = injectStageIntoTikTokStore(stageUrl, dir);
    expect(injected).toMatchObject({ ok: true, updatedExisting: false, sceneName: "Câmera em tela cheia" });
    expect(existsSync(path.join(dir, "services.json.lantern-backup"))).toBe(true);
    expect(readLocalTikTokStore(dir)).toEqual({ tiktokUsername: "curiosabolha", stageInjected: true, stageSourceUrl: stageUrl });

    const rotatedUrl = "http://localhost:8080/s/zyxwvuts87654321";
    expect(injectStageIntoTikTokStore(rotatedUrl, dir)).toMatchObject({ ok: true, updatedExisting: true });
    const sources = browserSources(dir);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({ name: "Vincular", visible: true, payload: { url: rotatedUrl, cx: 1080, cy: 1920, enableAudio: true } });
    expect(readLocalTikTokStore(dir).stageSourceUrl).toBe(rotatedUrl);
  });

  it("leaves the creator's own browser sources alone", () => {
    const dir = storeDir({
      mine: { id: "mine", name: "vincular minhas redes", type: "browser", visible: true, payload: { url: "https://linktr.ee/eu" } },
      lantern: { id: "lantern", name: "Lantern alerts", type: "browser", visible: true, payload: { url: "https://alerts.example/s/abcdefgh12345678" } },
    });
    const stageUrl = "http://localhost:8080/s/abcdefgh12345678";
    expect(injectStageIntoTikTokStore(stageUrl, dir)).toMatchObject({ ok: true, updatedExisting: false });
    const urls = browserSources(dir).map((s) => s.payload?.url);
    expect(urls).toContain("https://linktr.ee/eu");
    expect(urls).toContain("https://alerts.example/s/abcdefgh12345678");
    expect(urls).toContain(stageUrl);
  });

  it("waits for Studio to close before writing the scene file", async () => {
    const dir = storeDir();
    const system = fakeSystem({ running: true });
    const controller = controllerFor(null, { system, ttStoreDir: dir });
    const stageUrl = "http://localhost:8080/s/abcdefgh12345678";

    const queued = await controller.injectStage(stageUrl);
    expect(queued.ok).toBe(true);
    expect(queued.detail).toContain("Feche o TikTok LIVE Studio");
    expect(await controller.probe()).toMatchObject({ stagePending: true });
    expect(browserSources(dir)).toHaveLength(0);

    system.running = false;
    const probe = await controller.probe();
    expect(probe.stagePending).toBeUndefined();
    expect(probe.stageSourceUrl).toBe(stageUrl);
    expect(browserSources(dir)).toHaveLength(1);
  });
});

describe("fitLiveStudioProbe", () => {
  it("trims a big Studio setup to fit a bridge message", () => {
    const many = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i));
    const probe: LiveStudioProbe = {
      connected: true,
      port: 28189,
      streamStatus: "live",
      scene: "Cena 0",
      installed: true,
      executablePath: "C:\\Studio.exe",
      sceneList: many(80, (i) => `Cena ${i}`).map((name) => ({ name, sources: many(90, (j) => `fonte-${j}-${"x".repeat(40)}`).map((id) => ({ id, label: id, visible: true })) })),
      vibeList: many(70, (i) => `vibe-${i}`).map((id) => ({ id, name: id })),
      cameraEffects: {
        sources: [],
        types: [],
        categories: many(30, (i) => `cat-${i}`).map((key) => ({ key, name: key, effects: many(150, (j) => `fx-${j}`).map((id) => ({ id, label: id })) })),
      },
    };
    const fitted = fitLiveStudioProbe(probe);
    expect(JSON.stringify(fitted).length).toBeLessThan(12_500);
    expect(fitted.sceneList).toHaveLength(50);
    expect(fitted.sceneList?.[0]?.sources.length).toBeGreaterThan(0);
    expect(fitted.vibeList?.length).toBeGreaterThan(0);
  });
});

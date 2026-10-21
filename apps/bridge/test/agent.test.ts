import { describe, expect, it } from "bun:test";
import { encodeBridgeStamp, toBridgeWsUrl, type BridgeClientMessage, type LiveStudioProbe } from "@tik-live/shared";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeAgent } from "../src/agent";
import {
  injectStageIntoTikTokStore,
  readLocalTikTokStore,
  type LocalStudioController,
} from "../src/live-studio";
import { pairWithCode, readOwnStamp } from "../src/pair";

const idleController: LocalStudioController = {
  probe: async () => ({ connected: false, port: null, streamStatus: null, scene: null, installed: false, executablePath: null }),
  launch: async () => ({ ok: true, detail: "" }),
  start: async () => ({ ok: true, detail: "" }),
  stop: async () => ({ ok: true, detail: "" }),
};

describe("BridgeAgent", () => {
  it("converts Stage URLs into bridge WebSocket URLs", () => {
    expect(toBridgeWsUrl("https://lantern.example.com/s/abcdefgh12345678")).toBe(
      "wss://lantern.example.com/ws/bridge/abcdefgh12345678",
    );
    expect(toBridgeWsUrl("http://localhost:8080/s/abcdefgh12345678")).toBe(
      "ws://localhost:8080/ws/bridge/abcdefgh12345678",
    );
  });

  it("reads logged-in @username and injects 1080x1920 Stage Browser Source into TTStore/services.json", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "lantern-ttstore-"));
    try {
      const sceneId = "f9d3a8fc-1463-47c7-91f5-e6441262639e";
      const initialStore = {
        services: {
          UserService: {
            state: {
              userInfo: {
                username: "curiosabolha",
                display_id: "curiosabolha",
              },
            },
          },
          SourceService: {
            state: {
              currentSceneNew: sceneId,
              scenes: [{ id: sceneId, name: "Câmera em tela cheia" }],
              sceneSource: {
                [sceneId]: {
                  order: ["src-1"],
                  data: {
                    "src-1": {
                      id: "src-1",
                      name: "Adesivo de classificação do criador",
                      type: "rankingSticker",
                      visible: true,
                    },
                  },
                  theme: "Default",
                },
              },
            },
          },
        },
      };
      writeFileSync(path.join(tmpDir, "services.json"), JSON.stringify(initialStore, null, 2), "utf8");

      const before = readLocalTikTokStore(tmpDir);
      expect(before).toEqual({
        tiktokUsername: "curiosabolha",
        stageInjected: false,
      });

      const stageUrl = "http://localhost:8080/s/abcdefgh12345678";
      const injected = injectStageIntoTikTokStore(stageUrl, tmpDir);
      expect(injected.ok).toBe(true);
      expect(injected.updatedExisting).toBe(false);
      expect(injected.sceneName).toBe("Câmera em tela cheia");

      const after = readLocalTikTokStore(tmpDir);
      expect(after).toEqual({
        tiktokUsername: "curiosabolha",
        stageInjected: true,
      });

      // Injecting a new Stage URL updates the existing "Vincular" browser source in place
      const rotatedUrl = "http://localhost:8080/s/zyxwvuts87654321";
      const updated = injectStageIntoTikTokStore(rotatedUrl, tmpDir);
      expect(updated.ok).toBe(true);
      expect(updated.updatedExisting).toBe(true);

      const saved = JSON.parse(readFileSync(path.join(tmpDir, "services.json"), "utf8"));
      const sceneSources = Object.values(saved.services.SourceService.state.sceneSource[sceneId].data) as Array<{
        name: string;
        type: string;
        visible: boolean;
        payload?: { url?: string; cx?: number; cy?: number; enableAudio?: boolean };
      }>;
      const browserSources = sceneSources.filter((s) => s.type === "browser");
      expect(browserSources).toHaveLength(1);
      expect(browserSources[0]?.name).toBe("Vincular");
      expect(browserSources[0]?.visible).toBe(true);
      expect(browserSources[0]?.payload).toMatchObject({
        url: rotatedUrl,
        cx: 1080,
        cy: 1920,
        enableAudio: true,
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("connects to the server, pushes status, and executes start/stop/highlight/vibe/scene requests", async () => {
    const received: BridgeClientMessage[] = [];
    let status: "stopped" | "live" = "stopped";
    let currentScene = "Cena Principal";
    let recording = false;
    const triggeredVibes: string[] = [];

    const fakeController: LocalStudioController = {
      async probe(): Promise<LiveStudioProbe> {
        return {
          connected: true,
          port: 28189,
          streamStatus: status,
          scene: currentScene,
          installed: true,
          executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
          recording,
          highlightAble: status === "live",
          tiktokUsername: "curiosabolha",
          stageInjected: true,
        };
      },
      async launch() {
        return { ok: true, detail: "Aberto" };
      },
      async start() {
        status = "live";
        return { ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" };
      },
      async stop() {
        status = "stopped";
        return { ok: true, detail: "Desligada" };
      },
      async highlight() {
        return { ok: true, detail: "Clipe de destaque (60s) salvo no TikTok LIVE Studio!" };
      },
      async toggleRecording() {
        recording = !recording;
        return { ok: true, detail: recording ? "Gravação iniciada" : "Gravação parada" };
      },
      async switchScene(scene: string) {
        currentScene = scene;
        return { ok: true, detail: `Cena alterada para "${scene}".` };
      },
      async toggleSource(sourceId: string) {
        return { ok: true, detail: `Fonte ${sourceId} alternada.` };
      },
      async triggerVibe(vibeId: string) {
        triggeredVibes.push(vibeId);
        return { ok: true, detail: `Vibe "${vibeId}" acionada!` };
      },
      async setCameraEffect() {
        return { ok: true, detail: "Efeito aplicado." };
      },
      async injectStage() {
        return { ok: true, detail: "Cena configurada." };
      },
    };

    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ v: 1, t: "hello", channelId: "ch-1", channelName: "Lia" }));
          ws.send(JSON.stringify({ v: 1, t: "request", id: "req-1", action: "start" }));
          ws.send(JSON.stringify({ v: 1, t: "request", id: "req-2", action: "scene", params: { scene: "Câmera em tela cheia" } }));
          ws.send(JSON.stringify({ v: 1, t: "request", id: "req-3", action: "vibe", params: { vibeId: "Vitória!" } }));
          ws.send(JSON.stringify({ v: 1, t: "request", id: "req-4", action: "highlight" }));
        },
        message(_ws, raw) {
          received.push(JSON.parse(String(raw)) as BridgeClientMessage);
        },
      },
    });

    const agent = new BridgeAgent({
      url: `http://127.0.0.1:${server.port}/s/abcdefgh12345678`,
      controller: fakeController,
      pollMs: 500,
      onLog: () => undefined,
    });

    try {
      agent.start();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (received.some((m) => m.t === "response" && m.id === "req-4")) break;
        await Bun.sleep(25);
      }
      const res1 = received.find((m) => m.t === "response" && m.id === "req-1");
      const res2 = received.find((m) => m.t === "response" && m.id === "req-2");
      const res3 = received.find((m) => m.t === "response" && m.id === "req-3");
      const res4 = received.find((m) => m.t === "response" && m.id === "req-4");

      expect(res1?.t === "response" && res1.result?.ok).toBe(true);
      expect(res2?.t === "response" && res2.probe?.scene).toBe("Câmera em tela cheia");
      expect(res3?.t === "response" && res3.result?.detail).toContain("Vitória!");
      expect(res4?.t === "response" && res4.result?.detail).toContain("60s");
      expect(triggeredVibes).toEqual(["Vitória!"]);
    } finally {
      agent.stop();
      server.stop(true);
    }
  });

  it("connects with its paired device token and stops when the server unpairs it", async () => {
    let authorization: string | null = null;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname !== "/ws/bridge") return new Response("not found", { status: 404 });
        authorization = req.headers.get("authorization");
        if (srv.upgrade(req)) return;
        return new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open(ws) {
          ws.close(4003, "device removed");
        },
        message() {},
      },
    });
    let ended: number | null = null;
    const agent = new BridgeAgent({
      server: `http://127.0.0.1:${server.port}`,
      token: "lbt_secret",
      controller: idleController,
      onLog: () => undefined,
      onEnded: (code) => {
        ended = code;
      },
    });
    try {
      agent.start();
      const deadline = Date.now() + 5_000;
      while (ended === null && Date.now() < deadline) await Bun.sleep(25);
      expect(authorization as string | null).toBe("Bearer lbt_secret");
      expect(ended as number | null).toBe(4003);
    } finally {
      agent.stop();
      server.stop(true);
    }
  });
});

describe("pairing", () => {
  it("reads the app's address and code stamped onto its own executable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bridge-stamp-"));
    try {
      const exe = path.join(dir, "lantern-bridge.exe");
      writeFileSync(exe, Buffer.concat([Buffer.alloc(50_000, 7), encodeBridgeStamp({ server: "https://lantern.example", code: "ABCD2345" })]));
      expect(readOwnStamp(exe)).toEqual({ server: "https://lantern.example", code: "ABCD2345" });
      writeFileSync(exe, Buffer.alloc(50_000, 7));
      expect(readOwnStamp(exe)).toBeNull();
      expect(readOwnStamp(path.join(dir, "missing.exe"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("trades a code for a token and explains a refusal", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { code: string; device: string };
        if (body.code === "ABCD2345" && body.device === "PC") {
          return Response.json({ token: "lbt_x", deviceId: "d1", channelId: "c1", channelName: "Lia" });
        }
        return Response.json({ error: { code: "bad_pairing_code", message: "Código vencido." } }, { status: 400 });
      },
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      expect(await pairWithCode(base, "ABCD2345", "PC")).toEqual({ token: "lbt_x", deviceId: "d1", channelId: "c1", channelName: "Lia" });
      await expect(pairWithCode(base, "ZZZZ2345", "PC")).rejects.toThrow("Código vencido.");
    } finally {
      server.stop(true);
    }
  });
});

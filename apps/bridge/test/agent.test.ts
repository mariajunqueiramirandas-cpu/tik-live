import { describe, expect, it } from "bun:test";
import { BRIDGE_CLOSE, encodeBridgeStamp, toBridgeWsUrl, type BridgeClientMessage, type LiveStudioProbe } from "@tik-live/shared";
import type { LocalStudioController } from "@tik-live/shared/live-studio";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeAgent } from "../src/agent";
import { PairingNetworkError, pairWithCode, readOwnStamp } from "../src/pair";

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

  it("stops when another agent window takes its place, instead of fighting it", async () => {
    let connections = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return;
        return new Response("no upgrade", { status: 400 });
      },
      websocket: {
        open(ws) {
          connections += 1;
          ws.close(BRIDGE_CLOSE.replaced, "replaced by new bridge connection");
        },
        message() {},
      },
    });
    let ended: number | null = null;
    const agent = new BridgeAgent({
      server: `http://127.0.0.1:${server.port}`,
      token: "lbt_secret",
      controller: idleController,
      reconnectMs: 20,
      onLog: () => undefined,
      onEnded: (code) => {
        ended = code;
      },
    });
    try {
      agent.start();
      const deadline = Date.now() + 5_000;
      while (ended === null && Date.now() < deadline) await Bun.sleep(25);
      await Bun.sleep(200);
      expect(ended as number | null).toBe(BRIDGE_CLOSE.replaced);
      expect(connections).toBe(1);
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

  it("tells a server it couldn't reach apart from a refused code, so the code isn't spent", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const base = `http://127.0.0.1:${server.port}`;
    server.stop(true);
    await expect(pairWithCode(base, "ABCD2345", "PC")).rejects.toBeInstanceOf(PairingNetworkError);
  });
});

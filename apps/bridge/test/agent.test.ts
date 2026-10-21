import { describe, expect, it } from "bun:test";
import { encodeBridgeStamp, toBridgeWsUrl, type BridgeClientMessage, type LiveStudioProbe } from "@tik-live/shared";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeAgent } from "../src/agent";
import type { LocalStudioController } from "../src/live-studio";
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

  it("connects to the server, pushes status, and executes start/stop requests", async () => {
    const received: BridgeClientMessage[] = [];
    let status: "stopped" | "live" = "stopped";

    const fakeController: LocalStudioController = {
      async probe(): Promise<LiveStudioProbe> {
        return {
          connected: true,
          port: 28189,
          streamStatus: status,
          scene: "Cena Principal",
          installed: true,
          executablePath: "C:\\Program Files\\TikTok LIVE Studio\\1.38.0\\TikTok LIVE Studio.exe",
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
        if (received.some((m) => m.t === "response" && m.id === "req-1")) break;
        await Bun.sleep(25);
      }
      const response = received.find((m) => m.t === "response" && m.id === "req-1");
      expect(response).toBeDefined();
      if (response?.t === "response") {
        expect(response.result).toEqual({ ok: true, detail: "Transmitindo pelo TikTok LIVE Studio" });
        expect(response.probe?.streamStatus).toBe("live");
      }
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

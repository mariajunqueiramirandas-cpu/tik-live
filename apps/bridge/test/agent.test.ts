import { describe, expect, it } from "bun:test";
import { toBridgeWsUrl, type BridgeClientMessage, type LiveStudioProbe } from "@tik-live/shared";
import { BridgeAgent } from "../src/agent";
import type { LocalStudioController } from "../src/live-studio";

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
});

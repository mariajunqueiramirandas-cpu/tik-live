import type { Server, ServerWebSocket } from "bun";

/**
 * Where stage pages send their frames and voice (ADR-0020): one WebSocket
 * server per broadcaster, on the loopback interface only, with a random
 * token per session. Chromium runs in the same container, so frames never
 * leave the machine.
 */
export interface CaptureSink {
  video(frame: Uint8Array): void;
  audio(pcm: Uint8Array): void;
}

interface SocketData {
  token: string;
  kind: "video" | "audio";
}

const ROUTE = /^\/capture\/([A-Za-z0-9_-]{16,64})\/(video|audio)$/;
/** One 1080x1920 I420 frame is 3.1 MB; leave room above it. */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

export class CaptureServer {
  private server: Server<SocketData> | null = null;
  private readonly sinks = new Map<string, CaptureSink>();

  /** Registers a session and returns the endpoint its stage page connects to. */
  register(token: string, sink: CaptureSink): string {
    this.sinks.set(token, sink);
    const server = this.ensure();
    return `ws://127.0.0.1:${server.port}/capture/${token}`;
  }

  unregister(token: string): void {
    this.sinks.delete(token);
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private ensure(): Server<SocketData> {
    if (this.server) return this.server;
    const sinks = this.sinks;
    this.server = Bun.serve<SocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request, server) {
        const match = ROUTE.exec(new URL(request.url).pathname);
        if (!match || !sinks.has(match[1] as string)) return new Response("Not found", { status: 404 });
        const upgraded = server.upgrade(request, { data: { token: match[1] as string, kind: match[2] as "video" | "audio" } });
        return upgraded ? undefined : new Response("Expected a WebSocket", { status: 426 });
      },
      websocket: {
        maxPayloadLength: MAX_MESSAGE_BYTES,
        // Frames arrive at 30 per second; nothing is ever sent back.
        idleTimeout: 60,
        message(ws: ServerWebSocket<SocketData>, message) {
          if (typeof message === "string") return;
          const sink = sinks.get(ws.data.token);
          if (!sink) {
            ws.close(1008, "unknown session");
            return;
          }
          if (ws.data.kind === "video") sink.video(message);
          else sink.audio(message);
        },
      },
    });
    return this.server;
  }
}

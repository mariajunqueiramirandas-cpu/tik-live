import { BRIDGE_CLOSE, parseMessage, PROTOCOL_VERSION, STAGE_ROLES, studioClientMessageSchema, type StageRole } from "@tik-live/shared";
import type { ServerWebSocket } from "bun";
import type { Hono } from "hono";
import { upgradeWebSocket } from "hono/bun";
import type { WSContext } from "hono/ws";
import { deviceFromToken } from "../broadcast/bridge-pairing";
import type { AppDeps } from "../deps";
import { touchDevice } from "../repos/bridge";
import { getChannel } from "../repos/channels";
import type { Peer } from "../runtime/peer";
import type { AppEnv } from "./env";
import { requireUser } from "./middleware";
import { channelForStageKey } from "./routes/stage";

function toPeer(id: string, ws: WSContext): Peer {
  const raw = ws.raw as ServerWebSocket<unknown> | undefined;
  return {
    id,
    send: (data) => ws.send(data),
    bufferedAmount: () => raw?.getBufferedAmount?.() ?? 0,
    close: (code, reason) => ws.close(code, reason),
  };
}

const MAX_MESSAGE_BYTES = 16_384;

/**
 * Realtime endpoints (ADR-0008):
 * - `/ws/stage/:stageKey?role=program|preview|broadcast` for stage clients;
 * - `/ws/bridge` for the local TikTok LIVE Studio bridge agent on the user's PC,
 *   with its paired device token as `Authorization: Bearer` (ADR-0047);
 * - `/ws/bridge/:stageKey` for bridge agents from before pairing;
 * - `/ws/studio/:channelId` for the owner's dashboard.
 */
export function mountRealtime(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get(
    "/ws/stage/:stageKey",
    async (c, next) => {
      const channel = await channelForStageKey(deps, c.req.param("stageKey"));
      if (!channel) return c.text("Unknown stage link", 404);
      c.set("channel", channel);
      return next();
    },
    upgradeWebSocket((c) => {
      const channel = c.get("channel");
      const requested = c.req.query("role") ?? "program";
      const role: StageRole = (STAGE_ROLES as readonly string[]).includes(requested) ? (requested as StageRole) : "program";
      const id = crypto.randomUUID();
      return {
        onOpen(_event, ws) {
          void deps.manager.attachStage(channel, toPeer(id, ws), role);
        },
        onMessage(event) {
          const data = typeof event.data === "string" ? event.data : "";
          if (data.length > MAX_MESSAGE_BYTES) return;
          deps.manager.stageHub(channel.id)?.handleMessage(id, data);
        },
        onClose() {
          deps.manager.detachStage(channel.id, id);
        },
      };
    }),
  );

  app.get(
    "/ws/bridge",
    async (c, next) => {
      const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
      const found = token ? await deviceFromToken(deps, token) : undefined;
      c.set("bridgeDevice", found ? { id: found.device.id, channel: found.channel } : null);
      return next();
    },
    upgradeWebSocket((c) => {
      const paired = c.get("bridgeDevice");
      // "Last seen" for the dashboard's list of PCs: best effort, never worth failing a connection over.
      const seen = (deviceId: string) => void touchDevice(deps.db, deviceId, new Date(deps.now())).catch(() => undefined);
      const id = crypto.randomUUID();
      return {
        onOpen(_event, ws) {
          // Upgrade, then close with a code the agent understands: pair again.
          if (!paired) return ws.close(BRIDGE_CLOSE.unpaired, "unknown device");
          if (!deps.liveStudio.attachBridge(paired.channel, toPeer(id, ws), paired.id)) return ws.close(BRIDGE_CLOSE.busy, "another device is connected");
          seen(paired.id);
        },
        onMessage(event) {
          if (!paired) return;
          const data = typeof event.data === "string" ? event.data : "";
          if (data.length > MAX_MESSAGE_BYTES) return;
          deps.liveStudio.handleBridgeMessage(paired.channel.id, id, data);
        },
        onClose() {
          if (!paired) return;
          deps.liveStudio.detachBridge(paired.channel.id, id);
          seen(paired.id);
        },
      };
    }),
  );

  app.get(
    "/ws/bridge/:stageKey",
    async (c, next) => {
      const channel = await channelForStageKey(deps, c.req.param("stageKey"));
      if (!channel) return c.text("Unknown stage link", 404);
      c.set("channel", channel);
      return next();
    },
    upgradeWebSocket((c) => {
      const channel = c.get("channel");
      const id = crypto.randomUUID();
      return {
        onOpen(_event, ws) {
          deps.liveStudio.attachBridge(channel, toPeer(id, ws));
        },
        onMessage(event) {
          const data = typeof event.data === "string" ? event.data : "";
          if (data.length > MAX_MESSAGE_BYTES) return;
          deps.liveStudio.handleBridgeMessage(channel.id, id, data);
        },
        onClose() {
          deps.liveStudio.detachBridge(channel.id, id);
        },
      };
    }),
  );

  app.get(
    "/ws/studio/:channelId",
    requireUser(deps),
    async (c, next) => {
      const channel = await getChannel(deps.db, c.get("user").id, c.req.param("channelId"));
      if (!channel) return c.text("Not found", 404);
      c.set("channel", channel);
      return next();
    },
    upgradeWebSocket((c) => {
      const channel = c.get("channel");
      const id = crypto.randomUUID();
      return {
        onOpen(_event, ws) {
          void deps.manager.attachStudio(channel, toPeer(id, ws));
        },
        onMessage(event, ws) {
          const data = typeof event.data === "string" ? event.data : "";
          if (data.length > MAX_MESSAGE_BYTES) return;
          const message = parseMessage(studioClientMessageSchema, data);
          if (!message) {
            ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "ack", id: "?", ok: false, error: "Esse comando não foi entendido." }));
            return;
          }
          const result = deps.manager.command(channel.id, message.command);
          ws.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "ack", id: message.id, ok: result.ok, ...(result.ok ? {} : { error: result.error }) }));
        },
        onClose() {
          deps.manager.detachStudio(channel.id, id);
        },
      };
    }),
  );
}

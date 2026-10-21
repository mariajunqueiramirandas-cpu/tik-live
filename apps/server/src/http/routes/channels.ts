import {
  BRIDGE_CLOSE,
  broadcastUpdateSchema,
  channelCreateSchema,
  channelUpdateSchema,
  DEFAULT_SAFETY,
  downsample,
  findPreset,
  PLANS,
  type ChannelListItem,
  type LastStreamDto,
  type VoiceSettings,
} from "@tik-live/shared";
import { Hono } from "hono";
import { z } from "zod";
import { findBridgeExe, newPairingCode, stampedBridgeExe } from "../../broadcast/bridge-pairing";
import { randomToken } from "../../crypto/secrets";
import type { AppDeps } from "../../deps";
import { audit } from "../../repos/audit";
import { deleteDevice, listDevices } from "../../repos/bridge";
import {
  countChannels,
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
  type ChannelPatch,
  type ChannelRow,
} from "../../repos/channels";
import { loadSegmentScores } from "../../repos/segment-scores";
import { getSession, listSamples, listSessions, listUtterances } from "../../repos/streams";
import { SegmentScores } from "../../runtime/segment-scores";
import { regulars, topSupporters, viewerCount } from "../../repos/viewers";
import { toChannelDto } from "../dto";
import type { AppEnv } from "../env";
import { notFound, problem } from "../errors";
import { clientIp, rateLimit, requireUser } from "../middleware";
import { valid } from "../validate";

const idParam = z.object({ id: z.string() });
const sessionParam = z.object({ id: z.string(), sid: z.string() });
const deviceParam = z.object({ id: z.string(), deviceId: z.string() });

export function channelRoutes(deps: AppDeps) {
  const owned = async (userId: string, id: string): Promise<ChannelRow> => {
    const row = await getChannel(deps.db, userId, id);
    if (!row) throw notFound("Esse apresentador");
    return row;
  };

  const newStageKey = async () => {
    const key = randomToken(16);
    return { stageKeyLookup: await deps.secrets.lookup(key), stageKeyCiphertext: await deps.secrets.encrypt("stage-key", key), key };
  };

  const lastStream = async (channelId: string): Promise<LastStreamDto | null> => {
    const [session] = await listSessions(deps.db, channelId, 1);
    if (!session) return null;
    const samples = await listSamples(deps.db, session.id);
    return {
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      peakViewers: session.peakViewers,
      diamonds: session.diamonds,
      viewers: downsample(
        samples.map((s) => s.viewers),
        32,
      ),
    };
  };

  return new Hono<AppEnv>()
    .use(requireUser(deps))
    .get("/", async (c) => {
      const rows = await listChannels(deps.db, c.get("user").id);
      const channels: ChannelListItem[] = await Promise.all(
        rows.map(async (row) => ({ ...(await toChannelDto(deps, row)), lastStream: await lastStream(row.id) })),
      );
      return c.json({ channels });
    })
    .post("/", valid("json", channelCreateSchema), async (c) => {
      const user = c.get("user");
      const input = c.req.valid("json");
      const check = await deps.entitlements.canCreateChannel(user.id, await countChannels(deps.db, user.id));
      if (!check.ok) return problem(c, 402, check.code, check.message);
      const preset = findPreset(input.presetId);
      const stage = await newStageKey();
      const voice: VoiceSettings = { provider: deps.voices.providers[0] ?? "none", voiceId: null };
      const row = await createChannel(deps.db, {
        id: Bun.randomUUIDv7(),
        ownerId: user.id,
        name: input.name,
        tiktokUsername: input.tiktokUsername ?? null,
        source: input.tiktokUsername ? "tiktok" : "simulator",
        persona: input.timezone ? { ...preset.persona, timezone: input.timezone } : preset.persona,
        voice,
        safety: DEFAULT_SAFETY,
        broadcast: { enabled: false, rtmpUrl: null, streamKeyCiphertext: null, streamKeyLast4: null },
        desiredState: "stopped",
        stageKeyLookup: stage.stageKeyLookup,
        stageKeyCiphertext: stage.stageKeyCiphertext,
      });
      await audit(deps.db, { userId: user.id, action: "channel.created", target: row.id, ip: clientIp(c) });
      return c.json({ channel: await toChannelDto(deps, row) }, 201);
    })
    .get("/:id", valid("param", idParam), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      return c.json({ channel: await toChannelDto(deps, row) });
    })
    .patch("/:id", valid("param", idParam), valid("json", channelUpdateSchema), async (c) => {
      const user = c.get("user");
      const current = await owned(user.id, c.req.valid("param").id);
      const input = c.req.valid("json");
      const patch: ChannelPatch = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.tiktokUsername !== undefined) patch.tiktokUsername = input.tiktokUsername;
      if (input.source !== undefined) patch.source = input.source;
      if (input.persona !== undefined) patch.persona = input.persona;
      if (input.voice !== undefined) {
        // Fish voices are a list the operator vouches for (ADR-0030); any other id is refused.
        if (input.voice.provider === "fish" && input.voice.voiceId && !deps.voices.hasFishVoice(input.voice.voiceId)) {
          return problem(c, 400, "voice_not_found", "Essa voz não está disponível. Escolha uma da lista.");
        }
        patch.voice = input.voice;
      }
      if (input.safety !== undefined) patch.safety = input.safety;
      const source = patch.source ?? current.source;
      const handle = patch.tiktokUsername !== undefined ? patch.tiktokUsername : current.tiktokUsername;
      if (source === "tiktok" && !handle) {
        return problem(c, 400, "tiktok_handle_required", "Adicione o usuário do TikTok que este apresentador deve acompanhar.");
      }
      const row = await updateChannel(deps.db, user.id, current.id, patch);
      if (!row) throw notFound("Esse apresentador");
      await deps.manager.apply(row);
      return c.json({ channel: await toChannelDto(deps, row) });
    })
    .delete("/:id", valid("param", idParam), async (c) => {
      const user = c.get("user");
      const id = c.req.valid("param").id;
      await owned(user.id, id);
      await deps.manager.remove(id);
      await deleteChannel(deps.db, user.id, id);
      await audit(deps.db, { userId: user.id, action: "channel.deleted", target: id, ip: clientIp(c) });
      return c.body(null, 204);
    })
    .post("/:id/stage-key", valid("param", idParam), async (c) => {
      const user = c.get("user");
      const current = await owned(user.id, c.req.valid("param").id);
      const stage = await newStageKey();
      const row = await updateChannel(deps.db, user.id, current.id, {
        stageKeyLookup: stage.stageKeyLookup,
        stageKeyCiphertext: stage.stageKeyCiphertext,
      });
      if (!row) throw notFound("Esse apresentador");
      await deps.manager.rotateStageKey(row, stage.key);
      await audit(deps.db, { userId: user.id, action: "channel.stage_key_rotated", target: row.id, ip: clientIp(c) });
      return c.json({ channel: await toChannelDto(deps, row) });
    })
    .put("/:id/broadcast", valid("param", idParam), valid("json", broadcastUpdateSchema), async (c) => {
      const user = c.get("user");
      const current = await owned(user.id, c.req.valid("param").id);
      const input = c.req.valid("json");
      const plan = await deps.entitlements.planFor(user.id);
      if (input.enabled && !plan.limits.cloudBroadcast) {
        return problem(c, 402, "plan_no_broadcast", `A transmissão pela nuvem faz parte do plano ${PLANS.pro.name}.`);
      }
      if (input.enabled && !deps.config.BROADCAST_ENABLED) {
        return problem(c, 409, "broadcast_disabled", "A transmissão pela nuvem não está ligada neste servidor.");
      }
      const broadcast = { ...current.broadcast };
      if (input.enabled !== undefined) broadcast.enabled = input.enabled;
      if (input.liveStudio !== undefined) broadcast.liveStudio = input.liveStudio;
      if (input.rtmpUrl !== undefined) broadcast.rtmpUrl = input.rtmpUrl;
      if (input.streamKey !== undefined) {
        broadcast.streamKeyCiphertext = input.streamKey ? await deps.secrets.encrypt("stream-key", input.streamKey) : null;
        broadcast.streamKeyLast4 = input.streamKey ? input.streamKey.slice(-4) : null;
        await audit(deps.db, { userId: user.id, action: "channel.stream_key_changed", target: current.id, ip: clientIp(c) });
      }
      if (broadcast.enabled && !(broadcast.rtmpUrl && broadcast.streamKeyCiphertext)) {
        return problem(c, 400, "broadcast_incomplete", "Adicione o endereço do servidor e a chave de transmissão antes de ligar a transmissão pela nuvem.");
      }
      const row = await updateChannel(deps.db, user.id, current.id, { broadcast });
      if (!row) throw notFound("Esse apresentador");
      await deps.manager.apply(row);
      return c.json({ channel: await toChannelDto(deps, row) });
    })
    .post("/:id/broadcast/check", valid("param", idParam), valid("json", z.object({ rtmpUrl: z.string().trim().max(300).optional() })), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      const rtmpUrl = c.req.valid("json").rtmpUrl || row.broadcast.rtmpUrl;
      if (!rtmpUrl) return problem(c, 400, "broadcast_incomplete", "Adicione o endereço do servidor primeiro.");
      if (!deps.broadcasts) return problem(c, 409, "broadcast_disabled", "A transmissão pela nuvem não está ligada neste servidor.");
      return c.json(await deps.broadcasts.check(rtmpUrl));
    })
    .post("/:id/live-studio/check", valid("param", idParam), valid("json", z.object({ launch: z.boolean().optional() })), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      const { launch } = c.req.valid("json");
      return c.json(await deps.liveStudio.check({ channelId: row.id, ...(launch !== undefined ? { launch } : {}) }));
    })
    // Each download carries a fresh pairing code, so the copy pairs itself on first run (ADR-0047).
    .get(
      "/:id/live-studio/bridge.exe",
      rateLimit({ windowMs: 60_000, max: 10, key: (c) => `bridge-exe:${c.get("user").id}` }),
      valid("param", idParam),
      async (c) => {
        const row = await owned(c.get("user").id, c.req.valid("param").id);
        const exePath = findBridgeExe(deps.config.BRIDGE_EXE_PATH);
        if (!exePath) return problem(c, 404, "bridge_exe_not_built", "O lantern-bridge.exe não está disponível neste servidor.");
        return stampedBridgeExe(deps, exePath, row.id);
      },
    )
    .post(
      "/:id/live-studio/pairing",
      rateLimit({ windowMs: 60_000, max: 10, key: (c) => `bridge-pairing:${c.get("user").id}` }),
      valid("param", idParam),
      async (c) => {
        const row = await owned(c.get("user").id, c.req.valid("param").id);
        return c.json(await newPairingCode(deps, row.id));
      },
    )
    .get("/:id/live-studio/devices", valid("param", idParam), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      const connected = deps.liveStudio.connectedDevice(row.id);
      const devices = await listDevices(deps.db, row.id);
      return c.json({
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          createdAt: device.createdAt.toISOString(),
          lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
          connected: device.id === connected,
        })),
      });
    })
    .delete("/:id/live-studio/devices/:deviceId", valid("param", deviceParam), async (c) => {
      const user = c.get("user");
      const { id, deviceId } = c.req.valid("param");
      const row = await owned(user.id, id);
      if (!(await deleteDevice(deps.db, row.id, deviceId))) throw notFound("Esse computador");
      deps.liveStudio.closeBridgeDevice(row.id, deviceId, BRIDGE_CLOSE.unpaired, "device removed");
      await audit(deps.db, { userId: user.id, action: "channel.bridge_removed", target: row.id, meta: { deviceId }, ip: clientIp(c) });
      return c.body(null, 204);
    })
    .post(
      "/:id/start",
      rateLimit({ windowMs: 60_000, max: 20, key: (c) => `start:${c.get("user").id}` }),
      valid("param", idParam),
      async (c) => {
        const user = c.get("user");
        const row = await owned(user.id, c.req.valid("param").id);
        if (row.source === "tiktok" && !row.tiktokUsername) {
          return problem(c, 400, "tiktok_handle_required", "Adicione o usuário do TikTok que este apresentador deve acompanhar.");
        }
        const result = await deps.manager.start(row);
        if (!result.ok) return problem(c, result.code === "shutting_down" ? 503 : 402, result.code, result.message);
        await audit(deps.db, { userId: user.id, action: "channel.started", target: row.id, ip: clientIp(c) });
        const fresh = await owned(user.id, row.id);
        return c.json({ channel: await toChannelDto(deps, fresh) });
      },
    )
    .post("/:id/stop", valid("param", idParam), async (c) => {
      const user = c.get("user");
      const row = await owned(user.id, c.req.valid("param").id);
      await deps.manager.stop(row.id);
      await audit(deps.db, { userId: user.id, action: "channel.stopped", target: row.id, ip: clientIp(c) });
      const fresh = await owned(user.id, row.id);
      return c.json({ channel: await toChannelDto(deps, fresh) });
    })
    .get("/:id/sessions", valid("param", idParam), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      const sessions = await listSessions(deps.db, row.id, 60);
      return c.json({
        sessions: sessions.map((s) => ({
          id: s.id,
          startedAt: s.startedAt.toISOString(),
          endedAt: s.endedAt?.toISOString() ?? null,
          endReason: s.endReason,
          source: s.source,
          peakViewers: s.peakViewers,
          likes: s.likes,
          diamonds: s.diamonds,
          gifts: s.gifts,
          messages: s.messages,
          follows: s.follows,
          spokenLines: s.spokenLines,
          blockedLines: s.blockedLines,
          costUsd: s.costUsd,
        })),
      });
    })
    .get("/:id/sessions/:sid", valid("param", sessionParam), async (c) => {
      const params = c.req.valid("param");
      const row = await owned(c.get("user").id, params.id);
      const session = await getSession(deps.db, row.id, params.sid);
      if (!session) throw notFound("Essa live");
      const [samples, lines] = await Promise.all([listSamples(deps.db, session.id), listUtterances(deps.db, session.id, 1000)]);
      return c.json({
        session: {
          ...session,
          startedAt: session.startedAt.toISOString(),
          endedAt: session.endedAt?.toISOString() ?? null,
        },
        samples: samples.map((s) => ({ minute: s.minute.toISOString(), viewers: s.viewers, likes: s.likes, messages: s.messages, diamonds: s.diamonds })),
        lines: lines.map((l) => ({ at: l.at.toISOString(), text: l.text, emotion: l.emotion, status: l.status, reason: l.reason, turnKind: l.turnKind })),
      });
    })
    .get("/:id/audience", valid("param", idParam), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      const [supporters, regularViewers, remembered] = await Promise.all([
        topSupporters(deps.db, row.id, 10),
        regulars(deps.db, row.id, 10),
        viewerCount(deps.db, row.id),
      ]);
      const view = (v: (typeof supporters)[number]) => ({
        id: v.platformUserId,
        handle: v.handle,
        nickname: v.nickname,
        visits: v.visits,
        messages: v.messages,
        diamonds: v.diamonds,
        lastSeenAt: v.lastSeenAt.toISOString(),
      });
      return c.json({ remembered, supporters: supporters.map(view), regulars: regularViewers.map(view) });
    })
    .get("/:id/segments", valid("param", idParam), async (c) => {
      const row = await owned(c.get("user").id, c.req.valid("param").id);
      // Best first, as the show leans on them (ADR-0044). Lifts are log2: +1 is twice the stream's average.
      const scores = new SegmentScores(await loadSegmentScores(deps.db, row.id));
      return c.json({
        segments: scores.ranked().map((s) => ({
          key: s.key,
          title: s.title,
          kind: s.key.startsWith("game:") ? ("game" as const) : s.key.startsWith("talk:") ? ("talk" as const) : ("segment" as const),
          plays: s.plays,
          minutes: s.minutes,
          score: s.score,
          viewers: s.viewers,
          likes: s.likes,
          diamonds: s.diamonds,
          focus: scores.weight(s.key),
          lastPlayedAt: new Date(s.at).toISOString(),
        })),
      });
    });
}

import {
  encodeBridgeStamp,
  normalizePairingCode,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  type BridgePairResponse,
} from "@tik-live/shared";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomToken } from "../crypto/secrets";
import type { AppDeps } from "../deps";
import { claimPairing, createDevice, createPairing, deviceForToken, type BridgeDeviceRow } from "../repos/bridge";
import { getChannelById, type ChannelRow } from "../repos/channels";

/**
 * Pairing the Local Bridge Agent with a channel (ADR-0047): the dashboard
 * makes a short one-time code, the agent trades it for a long-lived device
 * token, and connects to `/ws/bridge` with that token from then on.
 */

const TOKEN_PREFIX = "lbt_";

/** Uniform over the alphabet: bytes past the last whole multiple of its length are skipped. */
function randomPairingCode(): string {
  const limit = 256 - (256 % PAIRING_CODE_ALPHABET.length);
  let code = "";
  while (code.length < PAIRING_CODE_LENGTH) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < limit && code.length < PAIRING_CODE_LENGTH) code += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
    }
  }
  return code;
}

const codeLookup = (deps: AppDeps, code: string) => deps.secrets.lookup(`bridge-pairing:${code}`);
const tokenLookup = (deps: AppDeps, token: string) => deps.secrets.lookup(`bridge-device:${token}`);

export async function newPairingCode(deps: AppDeps, channelId: string): Promise<{ code: string; expiresAt: string }> {
  const code = randomPairingCode();
  const now = deps.now();
  const expiresAt = new Date(now + PAIRING_CODE_TTL_MS);
  await createPairing(deps.db, { codeLookup: await codeLookup(deps, code), channelId, expiresAt }, new Date(now));
  return { code, expiresAt: expiresAt.toISOString() };
}

/** Trades a pairing code for a device token; null when the code is wrong, used or expired. */
export async function pairDevice(deps: AppDeps, input: { code: string; device?: string | undefined }): Promise<{ response: BridgePairResponse; channel: ChannelRow } | null> {
  const code = normalizePairingCode(input.code);
  if (!code) return null;
  const channelId = await claimPairing(deps.db, await codeLookup(deps, code), new Date(deps.now()));
  if (!channelId) return null;
  const channel = await getChannelById(deps.db, channelId);
  if (!channel) return null;
  const token = `${TOKEN_PREFIX}${randomToken(32)}`;
  const device = await createDevice(deps.db, {
    id: crypto.randomUUID(),
    channelId,
    name: input.device ?? "Computador",
    tokenLookup: await tokenLookup(deps, token),
  });
  return { response: { token, deviceId: device.id, channelId, channelName: channel.name }, channel };
}

export async function deviceFromToken(deps: AppDeps, token: string): Promise<{ device: BridgeDeviceRow; channel: ChannelRow } | undefined> {
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 128) return undefined;
  return deviceForToken(deps.db, await tokenLookup(deps, token));
}

/** Where the Windows build of the agent is: BRIDGE_EXE_PATH, or the workspace build in development. */
export function findBridgeExe(configured: string | undefined): string | null {
  const candidates = configured
    ? [configured]
    : [path.resolve(import.meta.dir, "../../../bridge/dist/lantern-bridge.exe"), path.resolve(process.cwd(), "apps/bridge/dist/lantern-bridge.exe")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** The agent's executable with this app's address and a fresh pairing code appended (see `encodeBridgeStamp`). */
export async function stampedBridgeExe(deps: AppDeps, exePath: string, channelId: string): Promise<Response> {
  const { code } = await newPairingCode(deps, channelId);
  const stamp = encodeBridgeStamp({ server: deps.config.publicOrigin, code });
  const file = Bun.file(exePath);
  const reader = file.stream().getReader();
  // Pull-based, so a slow download doesn't buffer the whole file in memory.
  // Bun sends a streamed body chunked, whatever Content-Length says; the
  // dashboard shows the size instead (`publicConfig().bridge.bytes`).
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (!done) return controller.enqueue(value);
      controller.enqueue(stamp);
      controller.close();
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/vnd.microsoft.portable-executable",
      "content-disposition": 'attachment; filename="lantern-bridge.exe"',
      "cache-control": "no-store",
    },
  });
}

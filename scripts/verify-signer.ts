/**
 * Checks the TikTok signer (ADR-0023) against a real LIVE, the one thing CI
 * can't do. Run it from the network the signer will run on, with the account
 * that's live: that's yours, or one whose owner agreed.
 *
 *   bun scripts/verify-signer.ts <handle> --url http://127.0.0.1:8091 --token <SIGNER_TOKEN> [--seconds 30]
 *
 * It asks the running signer whether the account is live, then connects the
 * app's real TikTok source through the signer and counts the events that
 * arrive by kind. Nothing is printed from the stream itself: no names, no
 * chat text. Exit code 0 means a connection opened.
 */
import { parseArgs } from "node:util";
import type { LiveEvent } from "../packages/shared/src/events";
import { createLogger } from "../apps/server/src/log";
import { HttpSignerClient, SignerClientError } from "../apps/server/src/runtime/sources/signer-client";
import { TikTokSource } from "../apps/server/src/runtime/sources/tiktok";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "http://127.0.0.1:8091" },
    token: { type: "string", default: process.env.SIGNER_TOKEN },
    seconds: { type: "string", default: "30" },
  },
});

const handle = positionals[0]?.replace(/^@/, "");
if (!handle || !values.token) {
  console.error("Usage: bun scripts/verify-signer.ts <handle> --url <signer url> --token <SIGNER_TOKEN> [--seconds 30]");
  process.exit(2);
}
const base = values.url!.replace(/\/$/, "");
const seconds = Math.max(5, Number(values.seconds));
const signer = new HttpSignerClient(base, values.token);

function explain(err: unknown): string {
  return err instanceof SignerClientError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
}

console.log(`1. Signer at ${base}`);
const health = (await fetch(`${base}/healthz`).then((r) => r.json(), () => null)) as { ready?: boolean; detail?: string } | null;
if (!health) {
  console.error("   not reachable. Is it running, and is the URL right?");
  process.exit(1);
}
console.log(`   ${health.ready ? "browser ready" : `browser not ready yet (${health.detail}); the first request starts it`}`);

console.log(`2. Room lookup for @${handle}`);
try {
  const room = await signer.lookupRoom(handle);
  if (!room.found) {
    console.error("   TikTok has no such account.");
    process.exit(1);
  }
  console.log(`   room ${room.roomId ?? "(none)"}, status ${room.status ?? "unknown"}: ${room.isLive ? "live" : "not live"}`);
  if (!room.isLive) {
    console.error("   Start the LIVE first, then run this again.");
    process.exit(1);
  }
} catch (err) {
  console.error(`   failed: ${explain(err)}`);
  process.exit(1);
}

console.log(`3. Joining the room through the signer, then listening for ${seconds} s`);
const counts = new Map<string, number>();
const source = new TikTokSource({
  username: handle,
  signer,
  log: createLogger("verify"),
  offlineRetryMs: 5_000,
});
await source.start((event: LiveEvent) => counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1));

const deadline = Date.now() + seconds * 1_000;
let connectedAt: number | null = null;
let lastDetail = "";
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const status = source.status();
  if (status.detail !== lastDetail) {
    console.log(`   ${status.detail}`);
    lastDetail = status.detail;
  }
  if (status.connected && connectedAt === null) connectedAt = Date.now();
}
await source.stop();

if (connectedAt === null) {
  console.error("\nNo connection opened. The last status above says why; the signer's own log has more.");
  console.error("A 403 or an empty answer from TikTok usually means it won't let this network join anonymously:");
  console.error("run the signer from another network, or set SIGNER_PROXY_URL to a residential proxy.");
  console.error("SIGNER_WEBCAST_ORIGIN=https://webcast.us.tiktok.com is the other host worth trying.");
  process.exit(1);
}
const summary = [...counts.entries()].map(([kind, n]) => `${kind} ${n}`).join(", ") || "none yet (a quiet room sends few events)";
console.log(`\nConnected after ${Math.round((connectedAt - (deadline - seconds * 1_000)) / 1_000)} s. Events by kind: ${summary}`);
process.exit(0);

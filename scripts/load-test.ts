/**
 * Load test (ADR-0017): many hosts in practice mode on one server, each with
 * a simulated OBS stage and an open studio, while /readyz is sampled for
 * event-loop lag. Cleans up after itself.
 *
 *   bun scripts/load-test.ts --channels 50 --seconds 120 [--url http://localhost:8080] [--gate <password>] [--allow-ai]
 *
 * Practice mode uses simulated viewers. If the server has AI keys, every host
 * makes real (paid) Claude calls, so that needs --allow-ai.
 */
import { parseArgs } from "node:util";

/** packages/shared/src/protocol.ts (root scripts can't import workspace packages). */
const PROTOCOL_VERSION = 2;

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://localhost:8080" },
    channels: { type: "string", default: "20" },
    seconds: { type: "string", default: "60" },
    users: { type: "string", default: "5" },
    gate: { type: "string" },
    "allow-ai": { type: "boolean", default: false },
  },
});

const base = values.url!.replace(/\/$/, "");
const channels = Number(values.channels);
const seconds = Number(values.seconds);
const users = Math.max(1, Number(values.users));
const auth = values.gate ? { authorization: `Basic ${btoa(`load:${values.gate}`)}` } : {};
const origin = new URL(base).origin;

async function api<T>(path: string, user: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries({ ...auth, origin, "x-dev-user": user })) headers.set(key, value);
  if (init.json) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers, ...(init.json ? { body: JSON.stringify(init.json) } : {}) });
  if (!res.ok && res.status !== 204) throw new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return (res.status === 204 ? undefined : await res.json()) as T;
}

const config = await api<{ ai: { enabled: boolean }; authMode: string }>("/api/config", "load-0");
if (config.authMode !== "dev") throw new Error("The load test uses dev sign-in (AUTH_MODE=dev).");
if (config.ai.enabled && !values["allow-ai"]) throw new Error("This server has AI turned on: every host would make paid Claude calls. Pass --allow-ai to accept that.");

console.log(`Creating ${channels} practice hosts across ${users} test users on ${base}…`);
const created: Array<{ id: string; user: string; stageUrl: string }> = [];
for (let i = 0; i < channels; i++) {
  const user = `load-${i % users}`;
  const { channel } = await api<{ channel: { id: string; stageUrl: string } }>("/api/channels", user, { method: "POST", json: { name: `Load ${i}` } });
  created.push({ id: channel.id, user, stageUrl: channel.stageUrl });
}

const stats = { speaks: 0, studioMessages: 0, socketErrors: 0, startFailures: 0 };
const sockets: WebSocket[] = [];
const wsBase = base.replace(/^http/, "ws");
for (const ch of created) {
  const key = ch.stageUrl.split("/s/")[1]!;
  const stage = new WebSocket(`${wsBase}/ws/stage/${key}?role=program`, { headers: auth } as never);
  // Plays queued lines in order, like OBS would, a little faster than real time.
  const queue: Array<{ id: string; durationMs: number }> = [];
  let playing = false;
  const playNext = () => {
    const head = queue[0];
    playing = head !== undefined;
    if (!head) return;
    setTimeout(() => {
      if (queue[0] !== head) return playNext();
      queue.shift();
      if (stage.readyState === 1) stage.send(JSON.stringify({ v: PROTOCOL_VERSION, t: "spoken", id: head.id }));
      playNext();
    }, Math.min(4000, head.durationMs / 2));
  };
  stage.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { t: string; id?: string; ids?: string[]; durationMs?: number };
    if (message.t === "cue" && message.id) {
      stats.speaks++;
      queue.push({ id: message.id, durationMs: message.durationMs ?? 2000 });
      if (!playing) playNext();
    } else if (message.t === "drop") {
      for (const id of message.ids ?? []) {
        const i = queue.findIndex((line, index) => index > 0 && line.id === id);
        if (i > 0) queue.splice(i, 1);
      }
    } else if (message.t === "stop") {
      queue.length = 0;
    }
  };
  stage.onerror = () => stats.socketErrors++;
  const studio = new WebSocket(`${wsBase}/ws/studio/${ch.id}?devUser=${ch.user}`, { headers: auth } as never);
  studio.onmessage = () => stats.studioMessages++;
  studio.onerror = () => stats.socketErrors++;
  sockets.push(stage, studio);
}

const startedAt = performance.now();
await Promise.all(
  created.map((ch) =>
    api(`/api/channels/${ch.id}/start`, ch.user, { method: "POST" }).catch((err: unknown) => {
      stats.startFailures++;
      console.error(String(err).slice(0, 200));
    }),
  ),
);
console.log(`Started in ${Math.round(performance.now() - startedAt)} ms. Running for ${seconds} s…`);

const lags: number[] = [];
const readyLatency: number[] = [];
const until = Date.now() + seconds * 1000;
while (Date.now() < until) {
  const t0 = performance.now();
  const ready = await fetch(`${base}/readyz`).then((r) => r.json() as Promise<{ eventLoopLagMs?: number; details?: { eventLoopLagMs?: number } }>).catch(() => null);
  readyLatency.push(performance.now() - t0);
  const lag = ready?.eventLoopLagMs ?? ready?.details?.eventLoopLagMs;
  if (typeof lag === "number") lags.push(lag);
  await Bun.sleep(2000);
}

const pct = (list: number[], q: number) => (list.length ? [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.floor(q * list.length))]! : 0);
console.log("\nResults");
console.log(`  hosts started        ${channels - stats.startFailures}/${channels}`);
console.log(`  lines spoken         ${stats.speaks} (${(stats.speaks / channels / (seconds / 60)).toFixed(1)} per host per minute)`);
console.log(`  studio messages      ${stats.studioMessages}`);
console.log(`  socket errors        ${stats.socketErrors}`);
console.log(`  event-loop lag       p50 ${pct(lags, 0.5)} ms, p95 ${pct(lags, 0.95)} ms, max ${Math.max(0, ...lags)} ms`);
console.log(`  /readyz latency      p50 ${pct(readyLatency, 0.5).toFixed(1)} ms, p95 ${pct(readyLatency, 0.95).toFixed(1)} ms`);

console.log("\nCleaning up…");
for (const socket of sockets) socket.close();
for (const ch of created) await api(`/api/channels/${ch.id}`, ch.user, { method: "DELETE" }).catch(() => undefined);
console.log("Done.");

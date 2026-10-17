import { expect, test } from "@playwright/test";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BrowserBackend, type BrowserBackendOptions } from "../apps/signer/src/browser-backend";
import { createLogger } from "../apps/signer/src/log";
import { oxylabsProvider } from "../apps/signer/src/proxy";

/**
 * The signer's browser backend against a local stand-in for TikTok (ADR-0023):
 * a page whose script patches XMLHttpRequest to sign webcast requests, but only
 * after a delay, as TikTok's does. The real TikTok can't be part of CI.
 */

interface Seen {
  path: string;
  query: Record<string, string>;
  userAgent: string;
}

const PROTOBUF = Buffer.from([0x0a, 0x04, 0x63, 0x31, 0x32, 0x33, 0x1a, 0x02, 0xff, 0x00]);
const ROOMS: Record<string, unknown> = {
  live_user: { statusCode: 0, data: { user: { roomId: "7000000000000000001", status: 2 } } },
  over_user: { statusCode: 0, data: { user: { roomId: "7000000000000000002", status: 4 } } },
  nobody: { statusCode: 19881007 },
};

const page = (hookDelayMs: number | null) => `<!doctype html><title>stand-in</title><script>
const delay = ${hookDelayMs ?? "null"};
if (delay !== null) setTimeout(() => {
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const u = new URL(url, location.href);
    if (u.pathname.startsWith("/webcast/")) {
      u.searchParams.set("msToken", "t");
      u.searchParams.set("X-Bogus", "b");
      u.searchParams.set("X-Gnarly", "g");
      u.searchParams.set("X-Dynosaur", "d");
    }
    return open.call(this, method, u.toString(), ...rest);
  };
  const own = new XMLHttpRequest();
  own.open("POST", "/webcast/room/enter/?aid=1988&device_id=7000000000000000009&region=BR&WebIdLastTime=1&channel_id=86");
  own.send();
}, delay);
</script>`;

let server: Server;
let origin: string;
let port: number;
let seen: Seen[] = [];
let pageLoads = 0;
/** Which exit addresses (proxy sessions) TikTok's stand-in refuses to let join a room. */
let refuse: "none" | "first" | "all" = "none";
const refusedExits = new Set<string>();

interface ProxySeen {
  user: string;
  password: string;
  path: string;
}
let proxyServer: Server;
let proxyPort: number;
let proxySeen: ProxySeen[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
  const url = new URL(req.url ?? "/", origin);
  const query = Object.fromEntries(url.searchParams);
  seen.push({ path: url.pathname, query, userAgent: String(req.headers["user-agent"] ?? "") });
  if (url.pathname === "/live" || url.pathname === "/live-unsigned") {
    pageLoads += 1;
    res.writeHead(200, { "content-type": "text/html", "set-cookie": "ttwid=from-the-page; Path=/" });
    res.end(page(url.pathname === "/live" ? 1200 : null));
    return;
  }
  if (url.pathname === "/api-live/user/room/") {
    if (query.uniqueId === "slow_user") await sleep(400);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ROOMS[query.uniqueId ?? ""] ?? ROOMS.nobody));
    return;
  }
  if (url.pathname === "/webcast/im/fetch/") {
    const signed = Boolean(query["X-Bogus"]);
    const room = query.room_id ?? "";
    const exit = String(req.headers["x-exit"] ?? "");
    if (exit && (refuse === "all" || (refuse === "first" && refusedExits.size === 0))) refusedExits.add(exit);
    // TikTok rejects an unsigned request with an empty 200, and so does a login wall.
    if (!signed || room === "7000000000000000003" || refusedExits.has(exit)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end();
    } else if (room === "7000000000000000004") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/x-protobuf", "x-room-id": room, "set-cookie": "s_v_web_id=abc; Path=/" });
      res.end(PROTOBUF);
    }
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

test.beforeAll(async () => {
  server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  // A stand-in for an Oxylabs entry node: an HTTP proxy that wants credentials and forwards to the
  // stand-in TikTok, telling it which session (exit address) each request left from. The page's own
  // requests arrive as plain forwards; the join Playwright sends on its behalf arrives in a CONNECT
  // tunnel, as HTTPS traffic to the real TikTok will.
  const credentials = (header: string | undefined) => {
    if (!header) return null;
    const decoded = Buffer.from(header.replace(/^Basic /i, ""), "base64").toString();
    const colon = decoded.indexOf(":");
    return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  };
  const forward = (req: IncomingMessage, res: ServerResponse, who: { user: string; password: string }) => {
    const target = new URL(req.url ?? "/", `http://${req.headers.host}`);
    proxySeen.push({ ...who, path: target.pathname });
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: target.host, "x-exit": who.user.match(/-sessid-([a-z0-9]+)-/)?.[1] ?? "" };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    const upstream = httpRequest({ host: "127.0.0.1", port, path: target.pathname + target.search, method: req.method, headers }, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };
  const challenge = 'Proxy-Authenticate: Basic realm="stand-in"';
  const tunneled = new WeakMap<object, { user: string; password: string }>();
  const tunnelServer = createServer((req, res) => forward(req, res, tunneled.get(req.socket)!));
  proxyServer = createServer((req, res) => {
    const who = credentials(req.headers["proxy-authorization"] as string | undefined);
    if (!who) {
      res.writeHead(407, { "proxy-authenticate": 'Basic realm="stand-in"' });
      res.end();
      return;
    }
    forward(req, res, who);
  });
  proxyServer.on("connect", (req, socket) => {
    const who = credentials(req.headers["proxy-authorization"] as string | undefined);
    if (!who) {
      socket.end(`HTTP/1.1 407 Proxy Authentication Required\r\n${challenge}\r\n\r\n`);
      return;
    }
    tunneled.set(socket, who);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    tunnelServer.emit("connection", socket);
  });
  await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
  proxyPort = (proxyServer.address() as AddressInfo).port;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => proxyServer.close(() => resolve()));
});

test.beforeEach(() => {
  seen = [];
  pageLoads = 0;
  proxySeen = [];
  refuse = "none";
  refusedExits.clear();
});

const backends: BrowserBackend[] = [];
test.afterEach(async () => {
  await Promise.all(backends.splice(0).map((b) => b.close()));
});

function backend(overrides: Partial<BrowserBackendOptions> = {}): BrowserBackend {
  const instance = new BrowserBackend({
    log: createLogger({ level: "error", sink: () => undefined }),
    ...(process.env.PW_CHROMIUM_PATH ? { chromiumPath: process.env.PW_CHROMIUM_PATH } : {}),
    locale: "pt-BR",
    timezone: "America/Sao_Paulo",
    warmupUrl: `${origin}/live`,
    webcastOrigin: origin,
    siteOrigin: origin,
    maxConcurrent: 2,
    maxQueue: 8,
    callTimeoutMs: 8_000,
    recycleMs: 60 * 60_000,
    readyTimeoutMs: 15_000,
    // Chromium's sandbox needs user namespaces, which CI runners and containers often don't allow.
    sandbox: false,
    ...overrides,
  });
  backends.push(instance);
  return instance;
}

test("waits for the page's signing hook, then returns the protobuf, cookies and room", async () => {
  const signer = backend();
  const started = Date.now();
  await signer.warmUp();
  // The stand-in's hook arrives 1.2 s after load: readiness has to be probed, not assumed.
  expect(Date.now() - started).toBeGreaterThan(1_000);

  const result = await signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" });
  expect(result.roomId).toBe("7000000000000000001");
  expect(Buffer.from(result.body).equals(PROTOBUF)).toBe(true);
  expect(result.cookies).toContain("s_v_web_id=abc; Path=/");
  // The response set no ttwid, so the one from the browser's jar is added: the websocket needs it.
  expect(result.cookies).toContain("ttwid=from-the-page");

  const fetched = seen.find((s) => s.path === "/webcast/im/fetch/");
  expect(fetched?.query).toMatchObject({
    room_id: "7000000000000000001",
    cursor: "",
    resp_content_type: "protobuf",
    identity: "audience",
    // Copied from the page's own room/enter request, so it matches the browser:
    device_id: "7000000000000000009",
    region: "BR",
    "X-Bogus": "b",
    "X-Gnarly": "g",
    msToken: "t",
  });
  // ...but nothing that belongs to another endpoint came along.
  expect(fetched?.query.channel_id).toBeUndefined();
  expect(fetched?.userAgent).toContain("Chrome/");
  expect(fetched?.userAgent).not.toContain("Headless");
  expect(signer.health()).toMatchObject({ ready: true, served: 1, failed: 0 });
});

test("looks rooms up: live, over and unknown", async () => {
  const signer = backend();
  expect(await signer.lookupRoom("live_user")).toEqual({ found: true, roomId: "7000000000000000001", status: 2, isLive: true });
  expect(await signer.lookupRoom("over_user")).toMatchObject({ found: true, status: 4, isLive: false });
  expect(await signer.lookupRoom("nobody")).toEqual({ found: false, roomId: null, status: null, isLive: false });
});

test("an empty answer is reported as a login wall, with the way out", async () => {
  const signer = backend();
  await expect(signer.fetchWebcast({ roomId: "7000000000000000003", cursor: "" })).rejects.toMatchObject({
    code: "empty_response",
    status: 502,
    message: expect.stringContaining("SIGNER_PROXY_URL"),
  });
  // The session is fine; the next room works.
  expect((await signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" })).body.length).toBeGreaterThan(0);
});

test("an HTTP error from TikTok is an upstream error", async () => {
  const signer = backend();
  await expect(signer.fetchWebcast({ roomId: "7000000000000000004", cursor: "" })).rejects.toMatchObject({
    code: "upstream",
    message: expect.stringContaining("403"),
  });
  await expect(signer.fetchWebcast({ roomId: "7000000000000000004", cursor: "" })).rejects.toThrow(/SIGNER_PROXY_URL/);
});

test("a page that never signs makes the signer unavailable, and it backs off", async () => {
  const signer = backend({ warmupUrl: `${origin}/live-unsigned`, readyTimeoutMs: 3_000 });
  await expect(signer.warmUp()).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("didn't start signing") });
  expect(signer.health().ready).toBe(false);
  const loads = pageLoads;
  await expect(signer.lookupRoom("live_user")).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("retries shortly") });
  expect(pageLoads).toBe(loads);
});

test("shares one answer between simultaneous joins of the same room", async () => {
  const signer = backend();
  await signer.warmUp();
  const [a, b] = await Promise.all([
    signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" }),
    signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" }),
  ]);
  expect(a).toBe(b);
  expect(seen.filter((s) => s.path === "/webcast/im/fetch/")).toHaveLength(1);
});

test("queues up to its limit and then says busy", async () => {
  const signer = backend({ maxConcurrent: 1, maxQueue: 1 });
  await signer.warmUp();
  const results = await Promise.allSettled([signer.lookupRoom("slow_user"), signer.lookupRoom("live_user"), signer.lookupRoom("over_user")]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
  expect((results[2] as PromiseRejectedResult).reason).toMatchObject({ code: "busy", status: 429 });
});

test("recovers when the browser dies", async () => {
  const signer = backend();
  await signer.warmUp();
  // Reach in and kill it, as an out-of-memory kill would.
  const session = (signer as unknown as { current: { browser: { close(): Promise<void> } } }).current;
  await session.browser.close();
  expect(signer.health().ready).toBe(false);
  expect(await signer.lookupRoom("live_user")).toMatchObject({ isLive: true });
  expect(pageLoads).toBe(2);
});

test("reloads an idle session once it is stale", async () => {
  let clock = 0;
  const signer = backend({ recycleMs: 1_000, now: () => clock });
  await signer.lookupRoom("live_user");
  expect(pageLoads).toBe(1);
  clock += 5_000;
  await signer.lookupRoom("live_user");
  expect(pageLoads).toBe(2);
});

// A host that isn't loopback, so Chromium sends it through the proxy (it never proxies 127.0.0.1).
const viaProxy = (overrides: Partial<BrowserBackendOptions> = {}) =>
  backend({
    warmupUrl: `http://tiktok.test:${port}/live`,
    webcastOrigin: `http://tiktok.test:${port}`,
    siteOrigin: `http://tiktok.test:${port}`,
    proxy: oxylabsProvider({ username: "resi_user", password: "p+w~:x/y", country: "br", endpoint: `127.0.0.1:${proxyPort}`, sessionMinutes: 40 }),
    ...overrides,
  });
const sessions = () => new Set(proxySeen.map((p) => p.user.match(/-sessid-([a-z0-9]+)-/)?.[1]));

test("Oxylabs: the page, the lookup and the signed join all leave through the proxy, on one sticky session", async () => {
  const signer = viaProxy();
  await signer.warmUp();
  expect(await signer.lookupRoom("live_user")).toMatchObject({ isLive: true });
  const joined = await signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" });
  expect(joined.body.length).toBeGreaterThan(0);

  const paths = new Set(proxySeen.map((p) => p.path));
  // The page itself, and the join that Playwright sends on the page's behalf.
  expect(paths).toContain("/live");
  expect(paths).toContain("/webcast/im/fetch/");
  // Every request carried the same credentials, with the session in the user name...
  expect(new Set(proxySeen.map((p) => p.user)).size).toBe(1);
  expect(proxySeen[0]?.user).toMatch(/^customer-resi_user-cc-BR-sessid-[a-z0-9]{12}-sesstime-40$/);
  // ...and the password arrived exactly as given, whatever characters it has.
  expect(new Set(proxySeen.map((p) => p.password))).toEqual(new Set(["p+w~:x/y"]));
  expect(sessions().size).toBe(1);
});

test("Oxylabs: a refused exit address is retried from a new session", async () => {
  refuse = "first";
  const signer = viaProxy({ refusalRetries: 1 });
  const joined = await signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" });
  expect(joined.body.length).toBeGreaterThan(0);
  // Two sessions, so two exit addresses: the refused one and the one that got in.
  expect(sessions().size).toBe(2);
  expect(refusedExits.size).toBe(1);
  expect(pageLoads).toBe(2);
});

test("Oxylabs: gives up after its retries and says so", async () => {
  refuse = "all";
  const signer = viaProxy({ refusalRetries: 1 });
  await expect(signer.fetchWebcast({ roomId: "7000000000000000001", cursor: "" })).rejects.toMatchObject({
    code: "empty_response",
    // Already on a proxy: the advice is about the proxy, not "use a proxy".
    message: expect.stringContaining("OXYLABS_COUNTRY"),
  });
  expect(sessions().size).toBe(2);
});

test("without a proxy a refusal isn't retried: the address would be the same", async () => {
  refuse = "all";
  const signer = backend({ refusalRetries: 3 });
  await expect(signer.fetchWebcast({ roomId: "7000000000000000003", cursor: "" })).rejects.toMatchObject({ code: "empty_response" });
  expect(pageLoads).toBe(1);
});

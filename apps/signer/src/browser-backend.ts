import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright-core";
import type { SignerRoomResponse } from "@tik-live/shared";
import { SignerError, type BackendHealth, type SignerBackend, type WebcastFetchResult } from "./backend";
import { Limiter } from "./limiter";
import type { Logger } from "./log";
import {
  baselineFromIdentity,
  baselineFromOwnRequest,
  parseRoomLookup,
  roomLookupUrl,
  webcastFetchUrl,
  type BrowserIdentity,
} from "./params";
import { describeProxy, type ProxyProvider } from "./proxy";

export interface BrowserBackendOptions {
  log: Logger;
  chromiumPath?: string;
  /** Where the browser's traffic leaves from; asked again for every new session. */
  proxy?: ProxyProvider;
  /** How many times a refused join is retried from a new session, which needs a proxy that can hand out another address. */
  refusalRetries?: number;
  locale: string;
  timezone: string;
  /** A TikTok page whose own script signs XHR requests. */
  warmupUrl: string;
  /** TikTok's webcast API (the region host its own page uses). */
  webcastOrigin: string;
  /** TikTok's web origin, for the room lookup. */
  siteOrigin: string;
  maxConcurrent: number;
  maxQueue: number;
  callTimeoutMs: number;
  recycleMs: number;
  /** How long the page gets to install its signing hook. */
  readyTimeoutMs: number;
  sandbox: boolean;
  now?: () => number;
}

interface Captured {
  url: string;
  status: number;
  setCookies: string[];
  roomId: string | null;
  body: Buffer;
}

interface PendingFetch {
  resolve(captured: Captured): void;
  reject(error: Error): void;
}

interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  identity: BrowserIdentity;
  startedAt: number;
  /** The first webcast request TikTok's own page made: the source of our device id and region. */
  ownRequest: string | null;
  pending: Map<string, PendingFetch>;
  users: number;
  failures: number;
  bad: boolean;
}

/** Cookies the room's websocket needs, copied from the browser's jar when the response doesn't set them. */
const WEBSOCKET_COOKIES = ["ttwid"];
const START_BACKOFF_MS = 5_000;
const BLOCKED_RESOURCES = new Set(["image", "media", "font"]);

/**
 * The environment the browser runs in: ours without anything that looks like a secret. Chromium runs
 * without its own sandbox (see SIGNER_SANDBOX), so a compromised page could otherwise read the
 * signer's token and proxy password from its parent's environment.
 */
const SECRET_NAME = /^(OXYLABS_|SIGNER_)|TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL/i;
export function browserEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined && !SECRET_NAME.test(name)) clean[name] = value;
  return clean;
}

/** TikTok's script adds `X-Bogus` (and friends) to the request it sends; its absence means nothing signed it. */
export function isSigned(url: string): boolean {
  return /[?&]X-Bogus=/.test(url);
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const GONE = /Target (page, context or browser )?has been closed|Target closed|browser has been closed|Browser closed|Connection closed|disconnected/i;

/**
 * Produces TikTok-signed requests by letting TikTok's own page do the signing
 * (ADR-0023). One Chromium keeps one TikTok page open; TikTok's script patches
 * XMLHttpRequest and appends its signature (X-Bogus, X-Gnarly, msToken,
 * X-Dynosaur) to webcast requests. We make the request as an XHR inside that
 * page, then take it over at the network layer: Playwright sends the signed
 * request itself, which sidesteps the page's CORS and CSP rules, and hands us
 * the raw response and its cookies.
 */
export class BrowserBackend implements SignerBackend {
  private current: Session | null = null;
  private starting: Promise<Session> | null = null;
  private readonly limiter: Limiter;
  private readonly inflightFetches = new Map<string, Promise<WebcastFetchResult>>();
  private readonly now: () => number;
  private served = 0;
  private failed = 0;
  private lastStartFailure = 0;
  private lastStartError = "";
  private closed = false;

  constructor(private readonly options: BrowserBackendOptions) {
    this.limiter = new Limiter(options.maxConcurrent, options.maxQueue);
    this.now = options.now ?? Date.now;
  }

  health(): BackendHealth {
    const session = this.current;
    const ready = Boolean(session && !session.bad);
    return {
      ready,
      detail: ready ? "ready" : this.starting ? "starting the browser" : this.lastStartError || "idle: the browser starts on the first request",
      sessionAgeSeconds: session ? Math.round((this.now() - session.startedAt) / 1000) : null,
      inflight: this.limiter.inflight,
      queued: this.limiter.queued,
      served: this.served,
      failed: this.failed,
    };
  }

  /** Starts the browser ahead of the first request, so it's ready when the first channel connects. */
  async warmUp(): Promise<void> {
    await this.acquire();
  }

  async close(): Promise<void> {
    this.closed = true;
    const session = this.current;
    this.current = null;
    if (session) await this.dispose(session);
    const starting = this.starting;
    if (starting) await starting.then((s) => this.dispose(s), () => undefined);
  }

  fetchWebcast(request: { roomId: string; cursor: string }): Promise<WebcastFetchResult> {
    // Two connections to one room at once would be indistinguishable on the wire; share the answer.
    const key = `${request.roomId}:${request.cursor}`;
    const existing = this.inflightFetches.get(key);
    if (existing) return existing;
    const job = this.limiter.run(() => this.join(request)).finally(() => this.inflightFetches.delete(key));
    this.inflightFetches.set(key, job);
    return job;
  }

  /**
   * One join, with new tries from a new browser session when TikTok refuses
   * the exit address: with a residential proxy each session gets its own
   * address, and addresses differ in how TikTok treats them.
   */
  private async join(request: { roomId: string; cursor: string }): Promise<WebcastFetchResult> {
    const retries = this.options.proxy ? (this.options.refusalRetries ?? 0) : 0;
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.use((session) => this.signedFetch(session, request));
      } catch (err) {
        if (!(err instanceof SignerError) || !err.refused || attempt >= retries) throw err;
        this.options.log.info("TikTok refused this exit address; trying another", { attempt: attempt + 1, of: retries });
      }
    }
  }

  async lookupRoom(uniqueId: string): Promise<SignerRoomResponse> {
    return this.limiter.run(() =>
      this.use(async (session) => {
        const url = roomLookupUrl(this.options.siteOrigin, uniqueId);
        const reply = await withTimeout(
          session.page.evaluate(async (target) => {
            const res = await fetch(target, { credentials: "include" });
            return { status: res.status, text: await res.text() };
          }, url),
          this.options.callTimeoutMs,
          () => new SignerError(504, "timeout", "TikTok didn't answer the room lookup in time."),
        );
        if (reply.status !== 200) throw new SignerError(502, "upstream", `TikTok answered the room lookup with HTTP ${reply.status}.`);
        let payload: unknown;
        try {
          payload = JSON.parse(reply.text);
        } catch {
          throw new SignerError(502, "upstream", "TikTok's room lookup didn't return JSON. It may be showing a captcha to this network.");
        }
        return parseRoomLookup(payload);
      }),
    );
  }

  private async signedFetch(session: Session, request: { roomId: string; cursor: string }): Promise<WebcastFetchResult> {
    const baseline = session.ownRequest ? baselineFromOwnRequest(session.ownRequest) : baselineFromIdentity(session.identity);
    const lastRtt = 100 + Math.floor(Math.random() * 100);
    const url = webcastFetchUrl(this.options.webcastOrigin, baseline, request, lastRtt);

    const captured = new Promise<Captured>((resolve, reject) => session.pending.set(request.roomId, { resolve, reject }));
    // Errors from the page itself surface through `pending` or the timeout below.
    void session.page
      .evaluate((target) => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", target);
        xhr.withCredentials = true;
        xhr.send();
      }, url)
      .catch((err: unknown) => session.pending.get(request.roomId)?.reject(err instanceof Error ? err : new Error(String(err))));

    let result: Captured;
    try {
      result = await withTimeout(captured, this.options.callTimeoutMs, () => new SignerError(504, "timeout", "TikTok didn't answer the room join request in time."));
    } finally {
      session.pending.delete(request.roomId);
    }

    if (result.status !== 200) {
      const refused = result.status === 403 ? ` It does that when it won't let this network join a room anonymously. ${this.networkHint()}` : "";
      throw new SignerError(502, "upstream", `TikTok answered the room join request with HTTP ${result.status}.${refused}`, result.status === 403);
    }
    if (result.body.length === 0) {
      throw new SignerError(
        502,
        "empty_response",
        `TikTok accepted the signed request but returned nothing. It does that when it won't let this network join a room anonymously (a login wall). ${this.networkHint()}`,
        true,
      );
    }
    const cookies = [...result.setCookies];
    for (const name of WEBSOCKET_COOKIES) {
      if (cookies.some((cookie) => cookie.startsWith(`${name}=`))) continue;
      const stored = (await session.context.cookies()).find((cookie) => cookie.name === name);
      if (stored) cookies.push(`${stored.name}=${stored.value}`);
    }
    return { roomId: result.roomId ?? request.roomId, cookies, body: result.body };
  }

  private networkHint(): string {
    return this.options.proxy
      ? "The signer already uses a proxy; try another country (OXYLABS_COUNTRY), a mobile proxy, or another network."
      : "Route the signer through a residential proxy (OXYLABS_USERNAME and OXYLABS_PASSWORD, or SIGNER_PROXY_URL) or run it from another network.";
  }

  /** The route handler for `webcast/im/fetch`: the page's script has signed it; we send it. */
  private async handleFetchRoute(session: Session, route: Route): Promise<void> {
    const url = route.request().url();
    const pending = session.pending.get(new URL(url).searchParams.get("room_id") ?? "");
    if (!pending) {
      await route.abort().catch(() => undefined);
      return;
    }
    if (!isSigned(url)) {
      pending.reject(new SignerError(502, "unsigned", "TikTok's page script didn't sign the request. Its signing may have changed; the browser session will be restarted."));
      await route.abort().catch(() => undefined);
      return;
    }
    try {
      const response = await route.fetch({ timeout: this.options.callTimeoutMs });
      const headers = response.headersArray();
      pending.resolve({
        url,
        status: response.status(),
        setCookies: headers.filter((h) => h.name.toLowerCase() === "set-cookie").map((h) => h.value),
        roomId: headers.find((h) => h.name.toLowerCase() === "x-room-id")?.value ?? null,
        body: await response.body(),
      });
    } catch (err) {
      pending.reject(new SignerError(502, "upstream", `The request to TikTok failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`));
    }
    // The page's own copy of the request has done its job.
    await route.abort().catch(() => undefined);
  }

  private async use<T>(job: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.acquire();
    session.users += 1;
    try {
      const result = await job(session);
      session.failures = 0;
      this.served += 1;
      return result;
    } catch (err) {
      this.failed += 1;
      const error = this.classify(err);
      session.failures += 1;
      if (error.code === "unsigned" || error.code === "unavailable" || session.failures >= 3) session.bad = true;
      // A refused exit address: drop the session so the next one starts on a new address.
      if (error.refused && this.options.proxy) session.bad = true;
      throw error;
    } finally {
      session.users -= 1;
      if (session.users === 0 && (session.bad || this.current !== session)) void this.dispose(session);
    }
  }

  private classify(err: unknown): SignerError {
    if (err instanceof SignerError) return err;
    const message = err instanceof Error ? err.message : String(err);
    if (GONE.test(message)) return new SignerError(503, "unavailable", "The browser went away. It will be restarted on the next request.");
    return new SignerError(500, "internal", message.split("\n")[0] ?? "Unexpected error.");
  }

  private async acquire(): Promise<Session> {
    if (this.closed) throw new SignerError(503, "unavailable", "The signer is shutting down.");
    const existing = this.current;
    if (existing) {
      const stale = this.now() - existing.startedAt > this.options.recycleMs;
      if (!existing.bad && !(stale && existing.users === 0)) return existing;
      this.current = null;
      if (existing.users === 0) void this.dispose(existing);
      // Otherwise the last job to finish with it disposes of it.
    }
    if (!this.starting) {
      const sinceFailure = this.now() - this.lastStartFailure;
      if (this.lastStartFailure && sinceFailure < START_BACKOFF_MS) {
        throw new SignerError(503, "unavailable", `${this.lastStartError} The signer retries shortly.`);
      }
      this.starting = this.startSession()
        .then((session) => {
          this.lastStartFailure = 0;
          this.lastStartError = "";
          if (this.closed) {
            void this.dispose(session);
            throw new SignerError(503, "unavailable", "The signer is shutting down.");
          }
          this.current = session;
          return session;
        })
        .catch((err: unknown) => {
          const error = err instanceof SignerError ? err : new SignerError(503, "unavailable", `The browser couldn't start: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}.`);
          this.lastStartFailure = this.now();
          this.lastStartError = error.message;
          // The API message stays short; Playwright's own text carries the browser's output, which says why.
          const detail = err instanceof Error ? err.message.replaceAll(/\s*\n\s*/g, " | ").slice(0, 600) : String(err);
          this.options.log.warn("signer session failed to start", { error: error.message, detail });
          throw error;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    return this.starting;
  }

  private async dispose(session: Session): Promise<void> {
    session.bad = true;
    for (const pending of session.pending.values()) pending.reject(new SignerError(503, "unavailable", "The browser session was closed."));
    session.pending.clear();
    await session.browser.close().catch(() => undefined);
  }

  private async startSession(): Promise<Session> {
    const { options } = this;
    const started = this.now();
    const proxy = options.proxy?.();
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: options.sandbox,
      env: browserEnv(process.env),
      args: ["--disable-dev-shm-usage"],
      ...(options.chromiumPath ? { executablePath: options.chromiumPath } : {}),
      ...(proxy ? { proxy } : {}),
    });
    try {
      const major = browser.version().split(".")[0] ?? "131";
      const context = await browser.newContext({
        userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        locale: options.locale,
        timezoneId: options.timezone,
        viewport: { width: 1280, height: 800 },
        // Requests to TikTok's webcast hosts are outside the page's own CSP; ours are sent by Playwright anyway.
        bypassCSP: true,
      });
      // The page stays open for a long time: don't download pictures, video or fonts it never shows.
      await context.route("**/*", (route) => (BLOCKED_RESOURCES.has(route.request().resourceType()) ? route.abort() : route.continue()));
      const page = await context.newPage();
      const session: Session = {
        browser,
        context,
        page,
        identity: { userAgent: "", language: options.locale, platform: "Win32", timezone: options.timezone, screenWidth: 1920, screenHeight: 1080 },
        startedAt: started,
        ownRequest: null,
        pending: new Map(),
        users: 0,
        failures: 0,
        bad: false,
      };
      browser.on("disconnected", () => {
        session.bad = true;
        if (this.current === session) this.current = null;
      });
      page.on("request", (request) => {
        if (!session.ownRequest && /\/webcast\/(room\/enter|feed)\//.test(request.url())) session.ownRequest = request.url();
      });
      await page.route("**/webcast/im/fetch/**", (route) => this.handleFetchRoute(session, route));
      await page.goto(options.warmupUrl, { waitUntil: "domcontentloaded", timeout: options.readyTimeoutMs });
      await this.waitForSigning(page);
      session.identity = await page.evaluate(() => ({
        userAgent: navigator.userAgent,
        language: navigator.language,
        platform: navigator.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        screenWidth: screen.width,
        screenHeight: screen.height,
      }));
      options.log.info("signer session ready", { ms: this.now() - started, ownRequestSeen: session.ownRequest !== null, ...(proxy ? { proxy: describeProxy(proxy) } : {}) });
      return session;
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw err;
    }
  }

  /**
   * TikTok's script installs its signing hook some seconds after the page
   * loads, later than other signs of life such as a patched fetch. So ask the
   * only question that matters: does a request made now come out signed?
   */
  private async waitForSigning(page: Page): Promise<void> {
    const probePath = "**/webcast/room/check_alive/**";
    let outcome: boolean | null = null;
    await page.route(probePath, async (route) => {
      outcome = isSigned(route.request().url());
      await route.abort().catch(() => undefined);
    });
    const probeUrl = `${this.options.webcastOrigin}/webcast/room/check_alive/?aid=1988&room_ids=0`;
    const deadline = this.now() + this.options.readyTimeoutMs;
    try {
      while (this.now() < deadline) {
        outcome = null;
        await page.evaluate((target) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", target);
          xhr.send();
        }, probeUrl);
        for (let waited = 0; waited < 1_500 && outcome === null; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
        if (outcome === true) return;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    } finally {
      await page.unroute(probePath).catch(() => undefined);
    }
    throw new SignerError(503, "unavailable", `TikTok's page didn't start signing requests within ${Math.round(this.options.readyTimeoutMs / 1000)} s. It may be blocking this network, or its script changed.`);
  }
}

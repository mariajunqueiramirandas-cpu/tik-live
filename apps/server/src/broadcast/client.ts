import type { BroadcasterList, BroadcastStatus, StartBroadcast } from "@tik-live/shared";

/** The app's view of the broadcaster service (ADR-0014). */
export interface BroadcasterClient {
  start(request: StartBroadcast): Promise<BroadcastStatus>;
  stop(channelId: string): Promise<void>;
  list(): Promise<BroadcasterList>;
  /** Validates an ingest server and checks it's reachable, without streaming. */
  check(rtmpUrl: string): Promise<{ ok: boolean; detail: string }>;
}

export class BroadcasterError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Talks to apps/broadcaster over its authenticated internal HTTP API. */
export class HttpBroadcasterClient implements BroadcasterClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new BroadcasterError(503, "unreachable", "The broadcast service isn't reachable right now.");
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
    if (!res.ok) throw new BroadcasterError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Broadcast service error (${res.status}).`);
    return data as T;
  }

  async start(request: StartBroadcast): Promise<BroadcastStatus> {
    return (await this.request<{ broadcast: BroadcastStatus }>("POST", "/broadcasts", request)).broadcast;
  }

  async stop(channelId: string): Promise<void> {
    await this.request("DELETE", `/broadcasts/${encodeURIComponent(channelId)}`);
  }

  list(): Promise<BroadcasterList> {
    return this.request<BroadcasterList>("GET", "/broadcasts");
  }

  check(rtmpUrl: string): Promise<{ ok: boolean; detail: string }> {
    return this.request("POST", "/broadcasts/check", { rtmpUrl });
  }
}

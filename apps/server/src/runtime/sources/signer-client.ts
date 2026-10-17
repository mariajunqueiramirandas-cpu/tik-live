import type { SignerRoomResponse, SignerWebcastResponse } from "@tik-live/shared";

/** The app's view of the signer service (ADR-0023): what a TikTok connection needs signed. */
export interface SignerClient {
  lookupRoom(uniqueId: string): Promise<SignerRoomResponse>;
  /** The signed join request for a room, which starts a connection. */
  fetchWebcast(roomId: string, cursor: string): Promise<SignerWebcastResponse>;
}

export class SignerClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Talks to apps/signer over its authenticated internal HTTP API. */
export class HttpSignerClient implements SignerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async request<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        // The signer gives TikTok 20 s to answer; leave room for the queue in front of it.
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new SignerClientError(503, "unreachable", "The TikTok signer isn't reachable right now.");
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: { code: string; message: string } }) | null;
    if (!res.ok) throw new SignerClientError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `The TikTok signer answered with HTTP ${res.status}.`);
    if (!data) throw new SignerClientError(502, "bad_response", "The TikTok signer sent a reply that isn't JSON.");
    return data;
  }

  lookupRoom(uniqueId: string): Promise<SignerRoomResponse> {
    return this.request("/v1/room", { uniqueId });
  }

  fetchWebcast(roomId: string, cursor: string): Promise<SignerWebcastResponse> {
    return this.request("/v1/webcast-fetch", { roomId, cursor });
  }
}

import type { SignerErrorCode, SignerRoomResponse } from "@tik-live/shared";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** A failure the API reports as-is: a stable code and a message that says what to do. */
export class SignerError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: SignerErrorCode,
    message: string,
    /** TikTok refused this network; another exit address might not be refused. */
    readonly refused = false,
  ) {
    super(message);
  }
}

export interface WebcastFetchResult {
  roomId: string;
  cookies: string[];
  /** TikTok's raw protobuf response. */
  body: Uint8Array;
}

export interface BackendHealth {
  ready: boolean;
  detail: string;
  sessionAgeSeconds: number | null;
  inflight: number;
  queued: number;
  served: number;
  failed: number;
}

/** What the API needs from whatever produces TikTok-signed requests. */
export interface SignerBackend {
  /** The signed `webcast/im/fetch` that starts a connection to a room. */
  fetchWebcast(request: { roomId: string; cursor: string }): Promise<WebcastFetchResult>;
  lookupRoom(uniqueId: string): Promise<SignerRoomResponse>;
  health(): BackendHealth;
  close(): Promise<void>;
}

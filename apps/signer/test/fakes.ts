import type { SignerRoomResponse } from "@tik-live/shared";
import { type BackendHealth, type SignerBackend, type WebcastFetchResult } from "../src/backend";

/** A backend that answers from memory: the API and the app's client are tested against this, never TikTok. */
export class FakeBackend implements SignerBackend {
  fetches: Array<{ roomId: string; cursor: string }> = [];
  lookups: string[] = [];
  nextFetch: WebcastFetchResult | Error = { roomId: "7000000000000000001", cookies: ["ttwid=abc; Path=/"], body: new Uint8Array([1, 2, 3]) };
  nextRoom: SignerRoomResponse | Error = { found: true, roomId: "7000000000000000001", status: 2, isLive: true };

  async fetchWebcast(request: { roomId: string; cursor: string }): Promise<WebcastFetchResult> {
    this.fetches.push(request);
    if (this.nextFetch instanceof Error) throw this.nextFetch;
    return this.nextFetch;
  }

  async lookupRoom(uniqueId: string): Promise<SignerRoomResponse> {
    this.lookups.push(uniqueId);
    if (this.nextRoom instanceof Error) throw this.nextRoom;
    return this.nextRoom;
  }

  health(): BackendHealth {
    return { ready: true, detail: "ready", sessionAgeSeconds: 5, inflight: 0, queued: 0, served: 0, failed: 0 };
  }

  async close(): Promise<void> {}
}

import { PROTOCOL_VERSION, type RuntimeSnapshot, type StudioServerPayload } from "@tik-live/shared";
import { BACKPRESSURE_BYTES, type Peer } from "./peer";

const DROPPABLE = new Set(["patch", "log", "live-event"]);

/**
 * The realtime feed for a channel's open dashboards (ADR-0008): a full
 * snapshot on connect, then coalesced patches plus discrete events.
 */
export class StudioFeed {
  private readonly peers = new Map<string, Peer>();
  private lastSent: Record<string, string> = {};

  attach(peer: Peer, snapshot: RuntimeSnapshot): void {
    this.peers.set(peer.id, peer);
    this.sendTo(peer, { t: "snapshot", state: snapshot });
  }

  detach(peerId: string): void {
    this.peers.delete(peerId);
  }

  isEmpty(): boolean {
    return this.peers.size === 0;
  }

  get size(): number {
    return this.peers.size;
  }

  publish(payload: StudioServerPayload): void {
    if (this.peers.size === 0) return;
    const data = JSON.stringify({ v: PROTOCOL_VERSION, ...payload });
    const droppable = DROPPABLE.has(payload.t);
    for (const peer of this.peers.values()) {
      if (droppable && peer.bufferedAmount() > BACKPRESSURE_BYTES) continue;
      peer.send(data);
    }
  }

  sendTo(peer: Peer, payload: StudioServerPayload): void {
    peer.send(JSON.stringify({ v: PROTOCOL_VERSION, ...payload }));
  }

  /**
   * Publishes the top-level fields that changed since the last call. Called
   * on a 250 ms tick, which is what coalesces bursts into at most 4 patches/s.
   */
  publishChanges(snapshot: RuntimeSnapshot): void {
    if (this.peers.size === 0) {
      this.lastSent = {};
      return;
    }
    const changed: Partial<RuntimeSnapshot> = {};
    let any = false;
    for (const [key, value] of Object.entries(snapshot)) {
      const encoded = JSON.stringify(value);
      if (this.lastSent[key] !== encoded) {
        this.lastSent[key] = encoded;
        (changed as Record<string, unknown>)[key] = value;
        any = true;
      }
    }
    // A peer that attached since the last tick may get fields it already has;
    // that's harmless, while resetting the baseline would starve older peers.
    if (any) this.publish({ t: "patch", state: changed });
  }
}

/** One realtime connection, independent of the WebSocket implementation (tests use fakes). */
export interface Peer {
  readonly id: string;
  send(data: string): void;
  /** Bytes queued but not yet sent (backpressure signal). */
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

/** Above this many queued bytes, droppable messages are skipped for that peer (ADR-0008). */
export const BACKPRESSURE_BYTES = 1_000_000;

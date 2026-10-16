/** A person in the LIVE audience, normalized across event sources. */
export interface Viewer {
  /** Stable numeric/string id from TikTok (falls back to handle). */
  id: string;
  /** The @handle without the "@". */
  handle: string;
  /** Display name; may contain emoji or be empty. */
  nickname: string;
}

interface Base {
  /** Epoch milliseconds when the event was received. */
  at: number;
}

export type LiveEvent =
  | (Base & { kind: "chat"; viewer: Viewer; text: string })
  | (Base & { kind: "question"; viewer: Viewer; text: string })
  | (Base & {
      kind: "gift";
      viewer: Viewer;
      giftName: string;
      /** How many of this gift were sent in the (finished) streak. */
      count: number;
      /** Total diamond value of the whole streak. */
      diamonds: number;
    })
  | (Base & { kind: "like"; viewer: Viewer; count: number; total?: number })
  | (Base & { kind: "follow"; viewer: Viewer })
  | (Base & { kind: "share"; viewer: Viewer })
  | (Base & { kind: "join"; viewer: Viewer })
  | (Base & { kind: "viewers"; count: number })
  | (Base & { kind: "stream_end"; reason: string });

export type LiveEventKind = LiveEvent["kind"];

export type EventListener = (event: LiveEvent) => void;

export interface SourceStatus {
  name: string;
  connected: boolean;
  detail: string;
}

/** Anything that produces LIVE events: the real TikTok connection or the simulator. */
export interface EventSource {
  readonly name: string;
  start(emit: EventListener): Promise<void>;
  stop(): Promise<void>;
  status(): SourceStatus;
}

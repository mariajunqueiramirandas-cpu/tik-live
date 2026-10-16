import type { LiveEvent } from "@tik-live/shared";

export type EventListener = (event: LiveEvent) => void;

export interface SourceStatus {
  name: string;
  connected: boolean;
  /** True once the TikTok room is actually live (always true for the simulator). */
  live: boolean;
  detail: string;
}

/** Anything that produces LIVE events: the real TikTok connection or the simulator. */
export interface EventSource {
  readonly name: string;
  start(emit: EventListener): Promise<void>;
  stop(): Promise<void>;
  status(): SourceStatus;
}

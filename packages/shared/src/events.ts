import { z } from "zod";
import "./zod-pt-br";

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
  | (Base & { kind: "stream_end"; reason: string })
  /**
   * TikTok asks the host to confirm they're still there (in TikTok LIVE Studio)
   * before the LIVE is ended for inactivity. Not an audience event: the host
   * brain never sees it, only the owner's dashboard.
   */
  | (Base & { kind: "inactivity_check"; captchaRecordId: string; verifyDurationInSec: number });

export type LiveEventKind = LiveEvent["kind"];

export function viewerName(viewer: Viewer): string {
  return viewer.nickname || viewer.handle;
}

/** A test event typed into the studio by the channel owner. */
export const injectEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("chat"), handle: z.string().trim().min(1).max(40), text: z.string().trim().min(1).max(300) }),
  z.object({
    kind: z.literal("gift"),
    handle: z.string().trim().min(1).max(40),
    giftName: z.string().trim().min(1).max(40).default("Rosa"),
    count: z.number().int().min(1).max(999).default(1),
    diamonds: z.number().int().min(1).max(50_000).default(1),
  }),
  z.object({ kind: z.literal("follow"), handle: z.string().trim().min(1).max(40) }),
  z.object({ kind: z.literal("share"), handle: z.string().trim().min(1).max(40) }),
]);

export type InjectEvent = z.infer<typeof injectEventSchema>;

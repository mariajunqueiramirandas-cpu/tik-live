import { z } from "zod";

/**
 * The signer's internal API (ADR-0023), shared by the app server and
 * apps/signer. The signer drives a real browser on TikTok's own web page so
 * that webcast requests carry TikTok's signature, which replaces the hosted
 * Euler Stream sign server. Every request carries
 * `Authorization: Bearer <SIGNER_TOKEN>`.
 */

/** TikTok's room ids are 64-bit integers, sent as decimal strings. */
export const signerWebcastRequestSchema = z.object({
  roomId: z.string().regex(/^\d{5,24}$/, "roomId must be TikTok's numeric room id"),
  /** Empty for the first fetch of a connection. */
  cursor: z.string().max(512).default(""),
});
export type SignerWebcastRequest = z.input<typeof signerWebcastRequestSchema>;

export const signerRoomRequestSchema = z.object({
  uniqueId: z.string().regex(/^[A-Za-z0-9._]{1,64}$/, "uniqueId is a TikTok handle without the @"),
});
export type SignerRoomRequest = z.input<typeof signerRoomRequestSchema>;

/** The signed `webcast/im/fetch` result: what the connector needs to open the room's websocket. */
export interface SignerWebcastResponse {
  roomId: string;
  /** `Set-Cookie` values from TikTok's response, as sent (`name=value; attributes`). */
  cookies: string[];
  /** The raw protobuf response (`ProtoMessageFetchResult`), base64. */
  body: string;
}

export interface SignerRoomResponse {
  /** False when TikTok has no such account. */
  found: boolean;
  roomId: string | null;
  /** TikTok's room status: 2 is live, 4 is over. */
  status: number | null;
  isLive: boolean;
}

export const SIGNER_ERROR_CODES = [
  "unauthorized",
  "invalid_input",
  /** The queue is full; retry with backoff. */
  "busy",
  /** The browser isn't ready (starting, crashed, or TikTok's page didn't load). */
  "unavailable",
  /** TikTok's page script didn't sign the request. */
  "unsigned",
  /** TikTok answered with an empty body: usually a login wall for this network. */
  "empty_response",
  /** TikTok answered with an error status. */
  "upstream",
  "timeout",
  "internal",
] as const;
export type SignerErrorCode = (typeof SIGNER_ERROR_CODES)[number];

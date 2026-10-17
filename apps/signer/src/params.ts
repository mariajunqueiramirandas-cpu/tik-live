import type { SignerRoomResponse } from "@tik-live/shared";
import { SignerError } from "./backend";

/** The browser facts TikTok's web client puts into every request it makes. */
export interface BrowserIdentity {
  userAgent: string;
  language: string;
  platform: string;
  timezone: string;
  screenWidth: number;
  screenHeight: number;
}

/**
 * Identity parameters worth copying from a request TikTok's own page made
 * (its device id, region and so on), so ours match the browser by
 * construction. Anything else on that request belongs to its endpoint.
 */
const IDENTITY_PARAMS = new Set([
  "WebIdLastTime", "aid", "app_language", "app_name", "browser_language", "browser_name", "browser_online",
  "browser_platform", "browser_version", "channel", "cookie_enabled", "data_collection_enabled", "device_id",
  "device_platform", "device_type", "focus_state", "from_page", "history_len", "is_fullscreen", "is_page_visible",
  "odinId", "os", "priority_region", "referer", "region", "root_referer", "screen_height", "screen_width",
  "tz_name", "user_is_login", "webcast_language",
]);

/** What `webcast/im/fetch` takes beyond the identity: the same values the connector's websocket uses. */
const FETCH_PARAMS: Record<string, string> = {
  aid: "1988",
  client_enter: "1",
  did_rule: "3",
  fetch_rule: "1",
  identity: "audience",
  internal_ext: "",
  live_id: "12",
  resp_content_type: "protobuf",
  update_version_code: "1.3.0",
  version_code: "180800",
  webcast_sdk_version: "1.3.0",
};

export function baselineFromOwnRequest(url: string): Record<string, string> {
  const baseline: Record<string, string> = {};
  for (const [key, value] of new URL(url).searchParams) if (IDENTITY_PARAMS.has(key)) baseline[key] = value;
  return baseline;
}

/** Used until the page has made a webcast request of its own to copy from. */
export function baselineFromIdentity(identity: BrowserIdentity): Record<string, string> {
  const ua = identity.userAgent;
  const language = identity.language || "en-US";
  return {
    app_language: language.split("-")[0] ?? "en",
    app_name: "tiktok_web",
    browser_language: language,
    browser_name: "Mozilla",
    browser_online: "true",
    browser_platform: identity.platform,
    browser_version: ua.startsWith("Mozilla/") ? ua.slice("Mozilla/".length) : ua,
    channel: "tiktok_web",
    cookie_enabled: "true",
    data_collection_enabled: "true",
    device_platform: "web_pc",
    focus_state: "true",
    from_page: "user",
    history_len: "10",
    is_fullscreen: "false",
    is_page_visible: "true",
    os: ua.includes("Macintosh") ? "mac" : ua.includes("Windows") ? "windows" : "linux",
    referer: "https://www.tiktok.com/",
    root_referer: "https://www.tiktok.com/",
    screen_height: String(identity.screenHeight),
    screen_width: String(identity.screenWidth),
    tz_name: identity.timezone,
    user_is_login: "false",
    webcast_language: language.split("-")[0] ?? "en",
  };
}

export function webcastFetchUrl(origin: string, baseline: Record<string, string>, request: { roomId: string; cursor: string }, lastRtt: number): string {
  const query = new URLSearchParams(baseline);
  for (const [key, value] of Object.entries(FETCH_PARAMS)) query.set(key, value);
  query.set("room_id", request.roomId);
  query.set("cursor", request.cursor);
  query.set("last_rtt", String(lastRtt));
  return `${origin}/webcast/im/fetch/?${query}`;
}

export function roomLookupUrl(origin: string, uniqueId: string): string {
  const query = new URLSearchParams({ aid: "1988", app_name: "tiktok_web", device_platform: "web_pc", sourceType: "54", uniqueId });
  return `${origin}/api-live/user/room/?${query}`;
}

/** TikTok's "no such user" code on the room lookup. */
const USER_NOT_FOUND = 19881007;

interface RoomLookupPayload {
  statusCode?: number;
  message?: string;
  data?: { user?: { roomId?: string; status?: number } };
}

export function parseRoomLookup(payload: unknown): SignerRoomResponse {
  const json = (payload ?? {}) as RoomLookupPayload;
  if (json.statusCode === USER_NOT_FOUND) return { found: false, roomId: null, status: null, isLive: false };
  if (json.statusCode) throw new SignerError(502, "upstream", `TikTok answered the room lookup with error ${json.statusCode}${json.message ? ` (${json.message})` : ""}.`);
  const user = json.data?.user;
  if (!user) throw new SignerError(502, "upstream", "TikTok's room lookup came back without a user. It may be showing a captcha to this network.");
  const roomId = user.roomId && user.roomId !== "0" ? String(user.roomId) : null;
  const status = typeof user.status === "number" ? user.status : null;
  // Same rule as the connector: anything but "over" counts as live while the room exists.
  return { found: true, roomId, status, isLive: roomId !== null && status !== null && status !== 4 };
}

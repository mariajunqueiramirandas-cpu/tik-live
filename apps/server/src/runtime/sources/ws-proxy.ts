import { randomUUID } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { oxylabsUsername } from "@tik-live/shared";

export interface OxylabsWsProxy {
  username: string;
  password: string;
  country?: string | undefined;
  /** host:port of the residential entry node. */
  endpoint: string;
}

/** The longest session Oxylabs keeps: a websocket stays up for a whole stream, so its address should too. */
const WS_SESSION_MINUTES = 1_440;

/**
 * An agent that opens a channel's TikTok websocket through an Oxylabs
 * residential proxy. `sessionId` pins one exit address to the channel for as
 * long as Oxylabs keeps it, so TikTok sees one steady viewer. Credentials go
 * through the URL object, which percent-encodes whatever characters they hold.
 */
export function oxylabsWsAgent(proxy: OxylabsWsProxy, sessionId: string = randomUUID().replaceAll("-", "").slice(0, 12)): HttpsProxyAgent<string> {
  const url = new URL(`http://${proxy.endpoint}`);
  url.username = oxylabsUsername({ username: proxy.username, country: proxy.country, sessionId, sessionMinutes: WS_SESSION_MINUTES });
  url.password = proxy.password;
  return new HttpsProxyAgent(url.toString());
}

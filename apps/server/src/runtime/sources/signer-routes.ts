import { RouteConfig, deserializeMessage, type TikTokLiveConnection } from "tiktok-live-connector";
import type { SignerClient } from "./signer-client";

/**
 * Connections that join rooms through our own signer (ADR-0023). Keyed by the
 * connection's HTTP client, which is what the connector hands every route, so
 * connections using the hosted Euler Stream sign server keep working beside
 * them in the same process.
 */
const signers = new WeakMap<object, SignerClient>();
let installed = false;

/**
 * The connector asks its "provider" (Euler Stream) for exactly one thing it
 * can't do itself: the signed `webcast/im/fetch` that starts a connection.
 * It documents `RouteConfig` as the place to swap that out.
 */
function installRoute(): void {
  if (installed) return;
  installed = true;
  const original = RouteConfig.fetchSignedWebSocketFromProvider;
  RouteConfig.fetchSignedWebSocketFromProvider = async (args) => {
    const signer = signers.get(args.webClient);
    if (!signer) return original(args);
    if (args.useMobile || args.authenticateWs || args.session) {
      throw new Error("The self-hosted signer only supports anonymous connections.");
    }
    const reply = await signer.fetchWebcast(args.roomId, args.cursor ?? "");
    // The websocket handshake needs these cookies (ttwid above all): the connector's jar sends them.
    for (const cookie of reply.cookies) await args.webClient.cookieJar.processSetCookieHeader(cookie);
    return {
      fetchResult: deserializeMessage("ProtoMessageFetchResult", Buffer.from(reply.body, "base64")),
      // Applied above, one cookie at a time: the connector's own parser takes a single cookie.
      fetchResultCookieHeader: "",
      fetchResultRoomId: reply.roomId,
    };
  };
}

/** Makes this connection join its room through `signer` instead of Euler Stream. */
export function useSigner(connection: TikTokLiveConnection, signer: SignerClient): void {
  installRoute();
  signers.set(connection.webClient, signer);
}

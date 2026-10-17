/**
 * Oxylabs residential proxies (ADR-0023). They take their options in the user
 * name: `customer-<user>-cc-<country>-sessid-<id>-sesstime-<minutes>`. The same
 * session id keeps the same exit address for `sesstime` minutes, so TikTok sees
 * one visitor rather than a new address on every request. Shared by the signer
 * and the app, which can't import each other.
 */
export const OXYLABS_DEFAULT_ENDPOINT = "pr.oxylabs.io:7777";

export interface OxylabsUser {
  /** The proxy user's name; "customer-" is added when it isn't there. */
  username: string;
  /** Two-letter country code for the exit address. Any country when unset. */
  country?: string | undefined;
  /** Letters and digits only. */
  sessionId: string;
  /** How long this session id keeps its exit address (1 to 1440). */
  sessionMinutes: number;
}

export function oxylabsUsername(user: OxylabsUser): string {
  const name = user.username.startsWith("customer-") ? user.username : `customer-${user.username}`;
  const parts = [name];
  if (user.country) parts.push("cc", user.country.toUpperCase());
  parts.push("sessid", user.sessionId, "sesstime", String(user.sessionMinutes));
  return parts.join("-");
}

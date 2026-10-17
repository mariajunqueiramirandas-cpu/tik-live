import { randomUUID } from "node:crypto";
import { oxylabsUsername } from "@tik-live/shared";

/** What Playwright takes for a browser's proxy: credentials stay separate, so no URL encoding is needed. */
export interface ProxySettings {
  server: string;
  username?: string;
  password?: string;
}

/** Called each time the browser session starts, so a provider can hand out a fresh exit address. */
export type ProxyProvider = () => ProxySettings;

export function parseProxy(url: string): ProxySettings {
  const parsed = new URL(url);
  return {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  };
}

export interface OxylabsOptions {
  /** The proxy user's name; "customer-" is added when it isn't there. */
  username: string;
  password: string;
  /** Two-letter country code for the exit address (BR, US, ...). Any country when unset. */
  country?: string;
  /** host:port of the residential entry node. */
  endpoint: string;
  /** How long one session id keeps the same exit address. */
  sessionMinutes: number;
}

/**
 * One sticky Oxylabs session per browser session, which is what the browser
 * needs: TikTok sees one visitor, not a new address on every request.
 */
export function oxylabsProxy(options: OxylabsOptions, sessionId: string = randomUUID().replaceAll("-", "").slice(0, 12)): ProxySettings {
  const username = oxylabsUsername({ username: options.username, country: options.country, sessionId, sessionMinutes: options.sessionMinutes });
  return { server: `http://${options.endpoint}`, username, password: options.password };
}

/** A provider that starts a new Oxylabs session, and so usually a new exit address, each time it's asked. */
export function oxylabsProvider(options: OxylabsOptions): ProxyProvider {
  return () => oxylabsProxy(options);
}

/** For logs: says which proxy is in use, never its credentials. */
export function describeProxy(settings: ProxySettings): string {
  const host = new URL(settings.server).host;
  return settings.username?.startsWith("customer-") ? `Oxylabs residential via ${host}` : `proxy ${host}`;
}

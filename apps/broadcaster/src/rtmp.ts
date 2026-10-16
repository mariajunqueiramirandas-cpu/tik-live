import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * RTMP target validation (ADR-0014, ADR-0016): rtmp/rtmps only, no
 * credentials in the URL, and never a private, loopback or link-local
 * address, so a stream key form can't be used to probe the internal network.
 */
export class RtmpUrlError extends Error {}

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1] as string);
  if (isIP(ip) === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = (0xffffffff << (32 - bits)) >>> 0;
      return ((n & mask) >>> 0) === ((ipv4ToInt(base) & mask) >>> 0);
    });
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

export interface RtmpCheckOptions {
  /** Development and tests only: allow local RTMP listeners. */
  allowPrivate?: boolean;
  resolve?: (host: string) => Promise<string[]>;
}

const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export async function validateRtmpUrl(raw: string, options: RtmpCheckOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new RtmpUrlError("That isn't a valid URL.");
  }
  if (url.protocol !== "rtmp:" && url.protocol !== "rtmps:") throw new RtmpUrlError("Use an rtmp:// or rtmps:// server URL.");
  if (url.username || url.password) throw new RtmpUrlError("Put the stream key in the stream key field, not in the URL.");
  if (!url.hostname) throw new RtmpUrlError("The server URL needs a host name.");
  if (options.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (options.resolve ?? defaultResolve)(host);
  } catch {
    throw new RtmpUrlError(`Couldn't find the server ${host}. Check the URL.`);
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new RtmpUrlError("That server address isn't allowed.");
  return url;
}

/** The ingest URL ffmpeg publishes to: server URL plus the stream key as the last path segment. */
export function ingestUrl(server: URL, streamKey: string): string {
  const base = server.toString().replace(/\/+$/, "");
  return `${base}/${streamKey}`;
}

/** Replaces the stream key wherever it might appear in text (ffmpeg logs, errors). */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 4) out = out.split(secret).join("[stream key]");
  return out;
}

/**
 * "Check connection" (ADR-0014): validates the URL and opens a TCP
 * connection to the ingest server, without publishing anything.
 */
export async function checkRtmpServer(
  raw: string,
  options: RtmpCheckOptions & { timeoutMs?: number; connect?: (host: string, port: number, timeoutMs: number) => Promise<void> } = {},
): Promise<{ ok: boolean; detail: string }> {
  let url: URL;
  try {
    url = await validateRtmpUrl(raw, options);
  } catch (err) {
    return { ok: false, detail: err instanceof RtmpUrlError ? err.message : "That server URL isn't usable." };
  }
  const port = url.port ? Number(url.port) : url.protocol === "rtmps:" ? 443 : 1935;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  try {
    await (options.connect ?? tcpConnect)(host, port, options.timeoutMs ?? 5000);
    return { ok: true, detail: `Reached ${host}:${port}.` };
  } catch {
    return { ok: false, detail: `Couldn't reach ${host}:${port}. Check the server URL.` };
  }
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) {
          clearTimeout(timer);
          socket.end();
          resolve();
        },
        data() {},
        error(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
        connectError(_socket, error) {
          clearTimeout(timer);
          reject(error);
        },
      },
    }).catch((error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { DjTrack } from "@tik-live/shared";
import type { Logger } from "../log";

export interface DjCacheOptions {
  dir: string;
  fetch?: typeof fetch;
  log?: Logger;
  now?: () => number;
}

/** The longest catalog file is under 18 MB; anything much bigger isn't the track. */
const MAX_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
/** After a failed fetch, a track isn't tried again for this long (the stage gets 503s meanwhile). */
const RETRY_AFTER_MS = 5 * 60_000;

/**
 * The automatic DJ's tracks on disk (ADR-0045). Each one is fetched from its
 * upstream once, the first time a runtime warms it or a stage asks for it,
 * written next to its final name and renamed into place, so a half-written
 * file is never served. Only catalog tracks can be asked for, so this is no
 * open proxy.
 */
export class DjCache {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly options: DjCacheOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The track's file on disk, fetching it first if needed; null when it can't be had right now. */
  async file(track: DjTrack): Promise<string | null> {
    const target = this.pathFor(track);
    if (await exists(target)) return target;
    const running = this.inFlight.get(track.id);
    if (running) return running;
    const failed = this.failedAt.get(track.id);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return null;
    const promise = this.download(track, target).finally(() => this.inFlight.delete(track.id));
    this.inFlight.set(track.id, promise);
    return promise;
  }

  /** Starts fetching a track in the background. */
  warm(track: DjTrack): void {
    void this.file(track);
  }

  private pathFor(track: DjTrack): string {
    return path.join(this.options.dir, `${track.id}.mp3`);
  }

  private async download(track: DjTrack, target: string): Promise<string | null> {
    const partial = `${target}.${process.pid}.part`;
    try {
      await mkdir(this.options.dir, { recursive: true });
      const response = await this.fetcher(track.upstream, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`upstream answered ${response.status}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_BYTES) throw new Error(`upstream file is ${declared} bytes`);
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.byteLength > MAX_BYTES) throw new Error(`upstream file is ${data.byteLength} bytes`);
      if (!looksLikeMp3(data)) throw new Error("upstream file isn't an MP3");
      await Bun.write(partial, data);
      await rename(partial, target);
      this.failedAt.delete(track.id);
      this.options.log?.info(`dj: cached "${track.title}" (${Math.round(data.byteLength / 1024)} KB)`);
      return target;
    } catch (err) {
      this.failedAt.set(track.id, this.now());
      this.options.log?.warn(`dj: could not fetch "${track.title}"`, err);
      await rm(partial, { force: true }).catch(() => {});
      return null;
    }
  }
}

/** An ID3 tag, or an MPEG audio frame sync, at the start. */
export function looksLikeMp3(data: Uint8Array): boolean {
  if (data.byteLength < 4) return false;
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return true;
  return data[0] === 0xff && ((data[1] as number) & 0xe0) === 0xe0;
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Parses a single-range `Range: bytes=...` header against a file of `size`
 * bytes: the inclusive byte range, "invalid" (answer 416), or null (no usable
 * range: send the whole file).
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match as unknown as [string, string, string];
  if (!from && !to) return "invalid";
  if (!from) {
    const suffix = Number(to);
    if (suffix === 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to ? Math.min(Number(to), size - 1) : size - 1;
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

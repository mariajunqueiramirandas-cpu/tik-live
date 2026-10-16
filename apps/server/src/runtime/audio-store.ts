import type { AudioClip } from "./voice/tts";

interface StoredClip {
  channelId: string;
  data: Buffer;
  mime: string;
  expires: number;
}

/**
 * Short-lived speech audio served to stage clients over HTTP (ADR-0008:
 * audio never travels over the socket). Bounded by age and total size.
 */
export class AudioStore {
  private readonly clips = new Map<string, StoredClip>();
  private bytes = 0;
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxBytes = 200 * 1024 * 1024,
    private readonly now: () => number = Date.now,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    (this.sweeper as { unref?: () => void }).unref?.();
  }

  put(channelId: string, cueId: string, clip: AudioClip): void {
    this.remove(cueId);
    this.clips.set(cueId, { channelId, data: clip.data, mime: clip.mime, expires: this.now() + this.ttlMs });
    this.bytes += clip.data.length;
    while (this.bytes > this.maxBytes && this.clips.size > 1) {
      const oldest = this.clips.keys().next().value as string;
      this.remove(oldest);
    }
  }

  /** Returns the clip only if it belongs to `channelId` and hasn't expired. */
  get(channelId: string, cueId: string): { data: Buffer; mime: string } | undefined {
    const clip = this.clips.get(cueId);
    if (!clip || clip.channelId !== channelId || clip.expires < this.now()) return undefined;
    return clip;
  }

  close(): void {
    clearInterval(this.sweeper);
    this.clips.clear();
    this.bytes = 0;
  }

  private remove(cueId: string): void {
    const clip = this.clips.get(cueId);
    if (!clip) return;
    this.bytes -= clip.data.length;
    this.clips.delete(cueId);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, clip] of this.clips) if (clip.expires < now) this.remove(id);
  }
}

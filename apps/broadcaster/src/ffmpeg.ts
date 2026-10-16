import type { VideoSettings } from "@tik-live/shared";

/**
 * ffmpeg turns the browser's WebM (VP8/Opus, the only codecs Chromium's
 * MediaRecorder offers) into what TikTok ingest expects: H.264 and AAC in
 * FLV, constant bitrate, a keyframe every two seconds (ADR-0014).
 */
export function ffmpegArgs(output: string, video: VideoSettings): string[] {
  const kbps = video.bitrateKbps;
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostats",
    "-progress", "pipe:2",
    "-stats_period", "5",
    "-fflags", "+genpts",
    "-thread_queue_size", "1024",
    "-f", "webm",
    "-i", "pipe:0",
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-vf", `scale=${video.width}:${video.height}:flags=bicubic,fps=${video.fps},format=yuv420p`,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-tune", "zerolatency",
    "-profile:v", "high",
    "-b:v", `${kbps}k`,
    "-maxrate", `${kbps}k`,
    "-bufsize", `${kbps * 2}k`,
    "-g", String(video.fps * 2),
    "-keyint_min", String(video.fps * 2),
    "-sc_threshold", "0",
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "44100",
    "-ac", "2",
    "-f", "flv",
    "-flvflags", "no_duration_filesize",
    output,
  ];
}

export interface EncoderStats {
  fps: number | null;
  bitrateKbps: number | null;
  droppedFrames: number | null;
  speed: number | null;
}

/**
 * Reads ffmpeg's `-progress` output: blocks of `key=value` lines ending in
 * `progress=continue`. Returns stats at the end of each block, else null.
 */
export class ProgressParser {
  private block: Record<string, string> = {};

  /** True for lines that belong to progress output (not warnings worth logging). */
  static isProgressLine(line: string): boolean {
    return /^[a-z_0-9]+=/.test(line.trim());
  }

  feed(line: string): EncoderStats | null {
    const trimmed = line.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1).trim();
    if (key !== "progress") {
      this.block[key] = value;
      return null;
    }
    const b = this.block;
    this.block = {};
    const num = (v: string | undefined) => {
      const n = Number.parseFloat(v ?? "");
      return Number.isFinite(n) ? n : null;
    };
    return {
      fps: num(b.fps),
      bitrateKbps: num(b.bitrate?.replace("kbits/s", "")),
      droppedFrames: num(b.drop_frames),
      speed: num(b.speed?.replace("x", "")),
    };
  }
}

import type { VideoSettings } from "@tik-live/shared";

export interface AudioInput {
  /** Unix socket ffmpeg listens on for the voice (16-bit little-endian stereo PCM). */
  socketPath: string;
  sampleRate: number;
}

export interface EncoderInput {
  /** "h264": H.264 encoded by the stage, in FLV (see flv.ts), copied untouched. "raw": I420 frames for x264. */
  video: "h264" | "raw";
  /** x264's speed preset (raw input only). */
  x264Preset?: string;
}

/**
 * Every input is fully described up front (the FLV opens with the avcC
 * record; raw video and PCM are declared here), so ffmpeg has nothing to
 * probe. Left to its default it reads 5 s of the live input first: 5 s of
 * dead air on every start and restart. Without it the stream is out in about
 * a second.
 */
const NO_PROBE = ["-analyzeduration", "0", "-probesize", "32"];

/**
 * ffmpeg turns what the stage sends into what TikTok ingest expects: H.264
 * and AAC in FLV, constant bitrate, a keyframe every two seconds (ADR-0014).
 * Since ADR-0020 the stage normally encodes the video itself and ffmpeg only
 * copies it and encodes the voice; with a browser that can't encode H.264,
 * raw I420 frames come in and x264 (AVX2 assembly, picked at runtime)
 * encodes them. Either way nothing is decoded or scaled.
 */
export function ffmpegArgs(output: string, video: VideoSettings, audio: AudioInput, input: EncoderInput = { video: "raw" }): string[] {
  const kbps = video.bitrateKbps;
  const videoIn =
    input.video === "h264"
      ? [...NO_PROBE, "-f", "flv", "-thread_queue_size", "256", "-i", "pipe:0"]
      : [...NO_PROBE, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-video_size", `${video.width}x${video.height}`, "-framerate", String(video.fps), "-thread_queue_size", "64", "-i", "pipe:0"];
  const videoOut =
    input.video === "h264"
      ? ["-c:v", "copy"]
      : [
          "-c:v", "libx264",
          "-preset", input.x264Preset ?? "superfast",
          "-tune", "zerolatency",
          "-profile:v", "high",
          // The stage converts with BT.709 limited range; say so, so players decode colors the same way.
          "-colorspace", "bt709",
          "-color_primaries", "bt709",
          "-color_trc", "bt709",
          "-color_range", "tv",
          "-b:v", `${kbps}k`,
          "-maxrate", `${kbps}k`,
          "-bufsize", `${kbps * 2}k`,
          "-g", String(video.fps * 2),
          "-keyint_min", String(video.fps * 2),
          "-sc_threshold", "0",
        ];
  return [
    "-hide_banner",
    "-loglevel", "warning",
    "-nostats",
    "-progress", "pipe:2",
    "-stats_period", "5",
    ...videoIn,
    ...NO_PROBE,
    "-f", "s16le",
    "-ar", String(audio.sampleRate),
    "-ch_layout", "stereo",
    "-thread_queue_size", "1024",
    "-listen", "1",
    "-i", `unix:${audio.socketPath}`,
    "-map", "0:v:0",
    "-map", "1:a:0",
    ...videoOut,
    "-c:a", "aac",
    "-b:a", "128k",
    "-ar", "48000",
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

  /**
   * Warnings that are expected and say nothing about this stream. The frame
   * rate one comes from not probing the input: the stage's FLV declares the
   * rate in its metadata instead.
   */
  static isNoise(line: string): boolean {
    return /not enough frames to estimate rate/.test(line);
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

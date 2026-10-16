/**
 * H.264 from the stage (ADR-0020) arrives as WebCodecs chunks with their
 * timestamps. A raw H.264 stream would lose those (ffmpeg's parser then
 * guesses, and stalls), so the broadcaster wraps the chunks in a minimal
 * video-only FLV stream that ffmpeg copies into the outgoing FLV untouched.
 *
 * Messages from the page on the video socket:
 *   [1][avcC]                                        decoder configuration
 *   [2][flags: 1 = keyframe][timestamp µs, f64 LE][AVCC frame]
 */
export type VideoMessage =
  | { kind: "config"; avcC: Uint8Array }
  | { kind: "frame"; key: boolean; timestampUs: number; data: Uint8Array };

export const VIDEO_CONFIG = 1;
export const VIDEO_FRAME = 2;
const FRAME_HEADER = 10;

export function parseVideoMessage(message: Uint8Array): VideoMessage | null {
  if (message.byteLength < 2) return null;
  if (message[0] === VIDEO_CONFIG) return { kind: "config", avcC: message.subarray(1) };
  if (message[0] === VIDEO_FRAME && message.byteLength > FRAME_HEADER) {
    const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
    return { kind: "frame", key: ((message[1] as number) & 1) === 1, timestampUs: view.getFloat64(2, true), data: message.subarray(FRAME_HEADER) };
  }
  return null;
}

/** Builds the bytes the page sends for a frame (also used by tests). */
export function frameMessage(data: Uint8Array, timestampUs: number, key: boolean): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER + data.byteLength);
  out[0] = VIDEO_FRAME;
  out[1] = key ? 1 : 0;
  new DataView(out.buffer).setFloat64(2, timestampUs, true);
  out.set(data, FRAME_HEADER);
  return out;
}

/** FLV container for one H.264 video track, timestamps in milliseconds from the first frame. */
export class FlvVideoMuxer {
  private started = false;
  private firstUs: number | null = null;

  constructor(private readonly video: { width: number; height: number; fps: number }) {}

  /** The FLV header and stream metadata, once, before any other tag. */
  private header(): Uint8Array {
    this.started = true;
    // "FLV", version 1, video only, header size 9, then PreviousTagSize0 = 0.
    const header = new Uint8Array([0x46, 0x4c, 0x56, 0x01, 0x01, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00]);
    // ffmpeg doesn't probe this input (it would hold the stream back 5 s), so
    // the frame rate has to be declared for it to reach the outgoing metadata.
    const metadata = onMetaData({ width: this.video.width, height: this.video.height, framerate: this.video.fps, videocodecid: 7 });
    return concat(header, this.tag(0, metadata, SCRIPT_TAG));
  }

  /** Turns one page message into FLV bytes (null: nothing to write yet). */
  push(message: VideoMessage): Uint8Array | null {
    if (message.kind === "config") {
      // AVC sequence header: keyframe + AVC codec, packet type 0, composition time 0, then avcC.
      const body = concat(new Uint8Array([0x17, 0x00, 0x00, 0x00, 0x00]), message.avcC);
      const tag = this.tag(0, body);
      return this.started ? tag : concat(this.header(), tag);
    }
    if (!this.started) return null; // no frame is decodable before the configuration
    this.firstUs ??= message.timestampUs;
    const ms = Math.max(0, Math.round((message.timestampUs - this.firstUs) / 1000));
    // Frame type (1 key, 2 inter) + AVC codec, packet type 1 (NALUs), composition time 0 (no B-frames).
    const body = concat(new Uint8Array([message.key ? 0x17 : 0x27, 0x01, 0x00, 0x00, 0x00]), message.data);
    return this.tag(ms, body);
  }

  private tag(timestampMs: number, body: Uint8Array, type = VIDEO_TAG): Uint8Array {
    const out = new Uint8Array(11 + body.byteLength + 4);
    const size = body.byteLength;
    out[0] = type;
    out[1] = (size >> 16) & 0xff;
    out[2] = (size >> 8) & 0xff;
    out[3] = size & 0xff;
    out[4] = (timestampMs >> 16) & 0xff;
    out[5] = (timestampMs >> 8) & 0xff;
    out[6] = timestampMs & 0xff;
    out[7] = (timestampMs >>> 24) & 0xff; // extended timestamp: the upper 8 bits
    // stream id: 3 zero bytes
    out.set(body, 11);
    new DataView(out.buffer).setUint32(11 + size, 11 + size);
    return out;
  }
}

const VIDEO_TAG = 9;
const SCRIPT_TAG = 18;

/** An AMF0 "onMetaData" script body: the name, then an ECMA array of numbers. */
function onMetaData(fields: Record<string, number>): Uint8Array {
  const text = new TextEncoder();
  const parts: number[] = [];
  const string = (value: string) => {
    const bytes = text.encode(value);
    parts.push(bytes.byteLength >> 8, bytes.byteLength & 0xff, ...bytes);
  };
  const number = (value: number) => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    parts.push(0x00, ...bytes);
  };
  parts.push(0x02);
  string("onMetaData");
  const entries = Object.entries(fields);
  parts.push(0x08, 0, 0, 0, entries.length);
  for (const [key, value] of entries) {
    string(key);
    number(value);
  }
  parts.push(0x00, 0x00, 0x09); // end of object
  return new Uint8Array(parts);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

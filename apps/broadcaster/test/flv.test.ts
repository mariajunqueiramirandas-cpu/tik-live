import { describe, expect, it } from "bun:test";
import { FlvVideoMuxer, frameMessage, parseVideoMessage, VIDEO_CONFIG } from "../src/flv";

const config = (avcC: number[]) => parseVideoMessage(new Uint8Array([VIDEO_CONFIG, ...avcC]))!;
const frame = (data: number[], us: number, key = false) => parseVideoMessage(frameMessage(new Uint8Array(data), us, key))!;
const muxer = () => new FlvVideoMuxer({ width: 720, height: 1280, fps: 30 });

/** Reads the numbers out of an AMF0 onMetaData body. */
function metadata(body: number[]): Record<string, number> {
  const bytes = new Uint8Array(body);
  const view = new DataView(bytes.buffer);
  const text = new TextDecoder();
  let at = 0;
  const string = () => {
    const length = view.getUint16(at);
    at += 2 + length;
    return text.decode(bytes.subarray(at - length, at));
  };
  expect(bytes[at++]).toBe(0x02);
  expect(string()).toBe("onMetaData");
  expect(bytes[at]).toBe(0x08);
  const count = view.getUint32(at + 1);
  at += 5;
  const out: Record<string, number> = {};
  for (let i = 0; i < count; i++) {
    const key = string();
    expect(bytes[at]).toBe(0x00);
    out[key] = view.getFloat64(at + 1);
    at += 9;
  }
  expect([...bytes.subarray(at)]).toEqual([0, 0, 9]);
  return out;
}

/** Reads FLV tags back: [type, timestampMs, body] for each, checking PreviousTagSize as it goes. */
function readTags(bytes: Uint8Array): Array<[number, number, number[]]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags: Array<[number, number, number[]]> = [];
  let at = 13;
  while (at < bytes.byteLength) {
    const size = (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const ts = ((bytes[at + 7]! << 24) | (bytes[at + 4]! << 16) | (bytes[at + 5]! << 8) | bytes[at + 6]!) >>> 0;
    tags.push([bytes[at]!, ts, [...bytes.subarray(at + 11, at + 11 + size)]]);
    expect(view.getUint32(at + 11 + size)).toBe(11 + size);
    at += 11 + size + 4;
  }
  return tags;
}

describe("video messages from the stage", () => {
  it("round-trips frames and reads the configuration", () => {
    expect(frame([7, 8], 1_000_000, true)).toEqual({ kind: "frame", key: true, timestampUs: 1_000_000, data: new Uint8Array([7, 8]) });
    expect(config([1, 2, 3])).toEqual({ kind: "config", avcC: new Uint8Array([1, 2, 3]) });
    expect(parseVideoMessage(new Uint8Array([9, 9]))).toBeNull();
    expect(parseVideoMessage(new Uint8Array([2, 1, 0]))).toBeNull();
  });
});

describe("FlvVideoMuxer", () => {
  it("writes a video-only FLV: header, metadata, AVC sequence header, then frames timed from the first", () => {
    const flv = muxer();
    // Frames before the configuration can't be decoded: nothing to write.
    expect(flv.push(frame([1], 0, true))).toBeNull();
    const head = flv.push(config([1, 0x42, 0xe0, 0x1f]))!;
    expect([...head.subarray(0, 13)]).toEqual([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
    const parts = [head, flv.push(frame([0xaa], 5_000_000, true))!, flv.push(frame([0xbb, 0xcc], 5_033_333))!];
    const all = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      all.set(p, o);
      o += p.byteLength;
    }
    const tags = readTags(all);
    expect(tags.slice(1)).toEqual([
      [9, 0, [0x17, 0, 0, 0, 0, 1, 0x42, 0xe0, 0x1f]],
      [9, 0, [0x17, 1, 0, 0, 0, 0xaa]],
      [9, 33, [0x27, 1, 0, 0, 0, 0xbb, 0xcc]],
    ]);
    // ffmpeg doesn't probe this input, so the frame rate comes from here.
    expect(tags[0]?.[0]).toBe(18);
    expect(metadata(tags[0]![2])).toEqual({ width: 720, height: 1280, framerate: 30, videocodecid: 7 });
  });

  it("carries timestamps past 16.7 million ms in the extended byte", () => {
    const flv = muxer();
    const head = flv.push(config([1]))!;
    flv.push(frame([1], 0, true));
    const late = flv.push(frame([2], 20_000_000_000))!; // 5.5 hours in
    const all = new Uint8Array(head.byteLength + late.byteLength);
    all.set(head);
    all.set(late, head.byteLength);
    expect(readTags(all)[2]?.[1]).toBe(20_000_000);
  });
});

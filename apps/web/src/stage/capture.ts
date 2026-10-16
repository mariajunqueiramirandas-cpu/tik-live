import type { StageEngine } from "@tik-live/engine";
import pcmTapUrl from "./pcm-tap.worklet.ts?worker&url";

/**
 * Cloud broadcast capture (ADR-0020), loaded only on broadcast stages. The
 * broadcaster opens the stage page in headless Chrome and calls
 * `window.__lantern.startCapture`; frames and voice then stream to its local
 * capture endpoint over two WebSockets.
 *
 * Video leaves the page already encoded when the browser has an H.264
 * encoder (Google Chrome does): about 0.4 MB a second instead of 41 MB of
 * raw frames, which costs Chrome about a core of IPC to move. Otherwise raw
 * I420 frames go out and the broadcaster encodes them with x264.
 */
export interface CaptureRequest {
  /** The broadcaster's endpoint for this session, e.g. ws://127.0.0.1:41234/capture/<token>. */
  endpoint: string;
  width: number;
  height: number;
  fps: number;
  /** Encode H.264 in the page if the browser can; absent: always send raw frames. */
  encode?: { bitrate: number; keyframeInterval: number };
}

export interface CaptureReady {
  sampleRate: number;
  channels: 2;
  /**
   * "h264": H.264 at exactly `fps` frames per second, as messages: [1][avcC]
   * for the decoder configuration, [2][keyframe][timestamp µs, f64 LE][AVCC
   * frame] per frame. "raw": I420 frames.
   */
  video: "h264" | "raw";
}

type FailureHook = (reason: string) => void;

export const counters = {
  /** Frames sent (raw) or encoded frames sent (h264). */
  sent: 0,
  /** Raw frames skipped because the socket was backed up. */
  backlogged: 0,
  /** Ticks that re-encoded the previous frame because no new one was ready (h264). */
  repeated: 0,
  /** Ticks skipped because the encoder had fallen behind (h264). */
  overloaded: 0,
  /** Average time to send one message, in ms. */
  sendMs: 0,
};

/** Encoded frames are never dropped; past this much unsent data something is wrong. */
const MAX_BUFFERED_ENCODED = 8 * 1024 * 1024;
const VIDEO_CONFIG = 1;
const VIDEO_FRAME = 2;

const BT709 = { primaries: "bt709", transfer: "bt709", matrix: "bt709", fullRange: false } as const;

export async function startCapture(engine: StageEngine, request: CaptureRequest): Promise<CaptureReady> {
  if (!engine.startCapture) throw new Error("WebGL2 isn't available, so this stage can't be captured");
  const [video, audio] = await Promise.all([open(`${request.endpoint}/video`), open(`${request.endpoint}/audio`)]);

  let stopVideo: () => void = () => undefined;
  let stopVoice: () => void = () => undefined;
  const fail = (reason: string) => {
    stopVideo();
    stopVoice();
    (window as unknown as { __lanternFailed?: FailureHook }).__lanternFailed?.(reason);
  };
  video.onclose = () => fail("The capture connection closed");
  audio.onclose = () => fail("The capture connection closed");

  const voice = await startVoice(engine, audio);
  stopVoice = voice.stop;
  const send = (data: Uint8Array<ArrayBuffer>) => {
    const start = performance.now();
    video.send(data);
    const took = performance.now() - start;
    counters.sendMs = counters.sent === 0 ? took : counters.sendMs * 0.95 + took * 0.05;
    counters.sent += 1;
  };

  const config = request.encode ? await h264Config(request) : null;
  if (config) {
    stopVideo = startEncoded(engine, request, config, video, send, fail);
    return { sampleRate: voice.sampleRate, channels: 2, video: "h264" };
  }

  // Raw frames. If the socket backs up (the encoder fell behind), skip frames
  // rather than queue them: the broadcaster repeats the last one and stays in time.
  const frameBytes = (request.width * request.height * 3) / 2;
  stopVideo = engine.startCapture({
    width: request.width,
    height: request.height,
    onFrame(frame) {
      if (video.readyState !== WebSocket.OPEN || video.bufferedAmount > frameBytes * 3) {
        counters.backlogged += 1;
        return;
      }
      send(frame);
    },
  });
  return { sampleRate: voice.sampleRate, channels: 2, video: "raw" };
}

/** The voice, as 16-bit stereo PCM in 20 ms packets, from an AudioWorklet tap. */
async function startVoice(engine: StageEngine, socket: WebSocket): Promise<{ sampleRate: number; stop(): void }> {
  await engine.audio.unlock();
  const tap = engine.audio.tap();
  if (!tap) throw new Error("Audio isn't available in this browser");
  await tap.context.audioWorklet.addModule(pcmTapUrl);
  const node = new AudioWorkletNode(tap.context, "pcm-tap", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: "explicit",
  });
  node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(event.data);
  };
  tap.node.connect(node);
  // Connected to the output only so the graph keeps pulling it; it outputs silence.
  node.connect(tap.context.destination);
  return { sampleRate: tap.context.sampleRate, stop: () => node.disconnect() };
}

/** A constrained-baseline H.264 config at the right level, if this browser can encode it. */
async function h264Config(request: CaptureRequest): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === "undefined" || !request.encode) return null;
  const macroblocks = Math.ceil(request.width / 16) * Math.ceil(request.height / 16);
  // Level 3.1 fits 720x1280 at 30 fps; 4.0 fits 1080x1920.
  const level = macroblocks <= 3600 ? "1f" : "28";
  const config: VideoEncoderConfig = {
    codec: `avc1.42e0${level}`,
    width: request.width,
    height: request.height,
    bitrate: request.encode.bitrate,
    framerate: request.fps,
    bitrateMode: "constant",
    latencyMode: "realtime",
    hardwareAcceleration: "prefer-software",
    // Length-prefixed NAL units plus an avcC record: what FLV carries, so the broadcaster just wraps them.
    avc: { format: "avc" },
  };
  try {
    return (await VideoEncoder.isConfigSupported(config)).supported ? config : null;
  } catch {
    return null;
  }
}

/**
 * Encodes exactly `fps` frames per second of this page's clock. Each frame
 * is encoded as soon as the engine delivers it, unless that would run ahead
 * of the clock; a timer covers frames that come late by encoding the
 * previous one again (an almost free frame for the encoder). Encoding on
 * arrival rather than on a timer of its own avoids two 30 Hz clocks drifting
 * past each other, which repeats one frame and drops the next. Timestamps
 * count frames from the start, so the stream is constant frame rate.
 */
function startEncoded(
  engine: StageEngine,
  request: CaptureRequest,
  config: VideoEncoderConfig,
  socket: WebSocket,
  send: (data: Uint8Array<ArrayBuffer>) => void,
  fail: (reason: string) => void,
): () => void {
  const { width, height, fps } = request;
  const keyframeInterval = request.encode!.keyframeInterval;
  const encoder = new VideoEncoder({
    output(chunk, metadata) {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_BUFFERED_ENCODED) {
        fail("The capture connection backed up");
        return;
      }
      const description = metadata?.decoderConfig?.description;
      if (description) {
        const avcC = ArrayBuffer.isView(description)
          ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
          : new Uint8Array(description);
        const config = new Uint8Array(1 + avcC.byteLength);
        config[0] = VIDEO_CONFIG;
        config.set(avcC, 1);
        send(config);
      }
      const message = new Uint8Array(10 + chunk.byteLength);
      message[0] = VIDEO_FRAME;
      message[1] = chunk.type === "key" ? 1 : 0;
      new DataView(message.buffer).setFloat64(2, chunk.timestamp, true);
      chunk.copyTo(message.subarray(10));
      send(message);
    },
    error: (error) => fail(`The video encoder stopped: ${error.message}`),
  });
  encoder.configure(config);

  const frameMs = 1000 / fps;
  const frameUs = 1e6 / fps;
  let latest: VideoFrame | null = null;
  let fresh = false;
  let tick = 0;
  let start = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** When tick k is due on this page's clock. */
  const due = (k: number) => start + k * frameMs;

  const encodeLatest = () => {
    if (!latest) return;
    if (!fresh) counters.repeated += 1;
    fresh = false;
    if (encoder.encodeQueueSize > 4) {
      counters.overloaded += 1;
    } else {
      const frame = new VideoFrame(latest, { timestamp: Math.round(tick * frameUs) });
      encoder.encode(frame, { keyFrame: tick % keyframeInterval === 0 });
      frame.close();
    }
    tick += 1;
    // Backstop: if the next frame isn't here half a frame after it's due, repeat this one.
    if (timer) clearTimeout(timer);
    timer = setTimeout(onLate, Math.max(0, due(tick) + frameMs / 2 - performance.now()));
  };
  const onLate = () => {
    timer = null;
    encodeLatest();
  };

  const stopCapture = engine.startCapture!({
    width,
    height,
    onFrame(frame) {
      // The constructor copies the bytes, so the engine can reuse its buffer.
      latest?.close();
      latest = new VideoFrame(frame, { format: "I420", codedWidth: width, codedHeight: height, timestamp: 0, colorSpace: BT709 });
      fresh = true;
      if (start === 0) start = performance.now();
      // More than half a frame early: hold it; it goes out at its tick (or a newer frame replaces it).
      if (performance.now() >= due(tick) - frameMs / 2) encodeLatest();
    },
  });

  return () => {
    if (timer) clearTimeout(timer);
    stopCapture();
    latest?.close();
    if (encoder.state !== "closed") encoder.close();
  };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("Couldn't reach the broadcaster's capture endpoint"));
  });
}

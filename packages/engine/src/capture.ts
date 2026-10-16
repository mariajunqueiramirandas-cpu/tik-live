import type { Gl, Program, QuadGeometry, RenderTarget } from "./gl/gl";

/**
 * Cloud broadcast capture (ADR-0020). The engine draws each frame into an
 * offscreen target instead of the canvas, so the browser never composites
 * it; two passes convert it to I420 on the rasterizer; the bytes come back
 * through a ring of pixel buffers with fences, so reading frame N overlaps
 * rendering frame N+1 and nothing ever waits on the GPU thread.
 */
export interface CaptureOptions {
  /** Output size; the width must be a multiple of 8 and the height of 4. */
  width: number;
  height: number;
  /**
   * Receives each frame as I420 (BT.709, limited range): width*height luma
   * bytes, then U and V at half resolution. The buffer is reused for the next
   * frame, so send or copy it before returning.
   */
  onFrame(frame: Uint8Array<ArrayBuffer>): void;
}

export interface CaptureStats {
  /** Frames handed to onFrame. */
  frames: number;
  /** Frames skipped because every readback buffer was still busy. */
  skipped: number;
  /** Average time from a frame's draw to its bytes reaching onFrame, in ms. */
  latencyMs: number;
  /** Average time copying a finished frame out of its readback buffer, in ms. */
  readMs: number;
}

/** Three frames in flight is enough to hide a slow frame without adding much delay. */
const RING = 3;
/** Interval between fence checks while a readback is in flight. */
const POLL_MS = 4;

export class FrameCapture {
  /** Where the engine draws while capturing. */
  readonly frame: RenderTarget;
  private readonly yuv: RenderTarget;
  private readonly bytes: number;
  private readonly scratch: Uint8Array<ArrayBuffer>;
  private buffers: WebGLBuffer[] = [];
  private readonly fences: Array<WebGLSync | null> = new Array(RING).fill(null);
  private readonly issuedAt = new Float64Array(RING);
  /** Slots with a readback in flight, oldest first. */
  private readonly pending: number[] = [];
  private next = 0;
  private stats: CaptureStats = { frames: 0, skipped: 0, latencyMs: 0, readMs: 0 };
  private disposed = false;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly gl: Gl,
    private readonly programs: { luma: Program; chroma: Program; quad: QuadGeometry },
    private readonly options: CaptureOptions,
  ) {
    const { width, height } = options;
    if (width % 8 !== 0 || height % 4 !== 0 || width <= 0 || height <= 0) {
      throw new Error(`Capture size must be a multiple of 8 x 4 (got ${width}x${height})`);
    }
    this.bytes = (width * height * 3) / 2;
    this.scratch = new Uint8Array(new ArrayBuffer(this.bytes));
    this.frame = gl.target("low");
    this.frame.resize(width, height);
    this.yuv = gl.target("low");
    this.yuv.resize(width / 4, (height * 3) / 2);
    this.rebuild();
    gl.track(this);
  }

  get counters(): CaptureStats {
    return { ...this.stats, latencyMs: Math.round(this.stats.latencyMs * 10) / 10, readMs: Math.round(this.stats.readMs * 100) / 100 };
  }

  /** After the engine drew a frame into `frame`: convert it and start reading it back. */
  afterDraw(): void {
    if (this.disposed) return;
    const g = this.gl.gl;
    const slot = this.next;
    if (this.fences[slot]) {
      // Every buffer is still being read: skip this frame rather than stall.
      this.stats.skipped += 1;
      return;
    }
    const { width, height } = this.options;
    const { luma, chroma, quad } = this.programs;
    g.disable(g.BLEND);
    this.yuv.bindForDrawing();
    this.frame.bind(0);
    g.viewport(0, 0, width / 4, height);
    luma.use().i("u_frame", 0).i2("u_size", width, height);
    quad.draw();
    g.viewport(0, height, width / 4, height / 2);
    chroma.use().i("u_frame", 0).i2("u_size", width, height);
    quad.draw();

    g.bindBuffer(g.PIXEL_PACK_BUFFER, this.buffers[slot] as WebGLBuffer);
    g.readPixels(0, 0, width / 4, (height * 3) / 2, g.RGBA, g.UNSIGNED_BYTE, 0);
    g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
    this.fences[slot] = g.fenceSync(g.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.issuedAt[slot] = performance.now();
    this.pending.push(slot);
    this.next = (slot + 1) % RING;
    g.flush();
    this.pump();
  }

  /**
   * Reads frames back as soon as they're finished, before the next frame's
   * commands are queued: in Chromium, reading a buffer waits for everything
   * queued ahead of it, so reading frame N after frame N+1 was submitted
   * would stall this thread for a whole render and cost frames.
   */
  private pump(): void {
    if (this.pumpTimer !== null || this.disposed) return;
    const tick = () => {
      this.pumpTimer = null;
      this.poll();
      if (this.pending.length > 0 && !this.disposed) this.pumpTimer = setTimeout(tick, POLL_MS);
    };
    // Checking a fence isn't free in Chromium: wait for most of the usual
    // readback time before the first check, then check every few ms.
    this.pumpTimer = setTimeout(tick, Math.max(POLL_MS, this.stats.latencyMs * 0.8));
  }

  /** Hands over every frame whose readback has finished. Never blocks. */
  poll(): void {
    if (this.disposed) return;
    const g = this.gl.gl;
    while (this.pending.length > 0) {
      const slot = this.pending[0] as number;
      const fence = this.fences[slot] as WebGLSync;
      const status = g.clientWaitSync(fence, 0, 0);
      if (status === g.TIMEOUT_EXPIRED) return;
      this.pending.shift();
      g.deleteSync(fence);
      this.fences[slot] = null;
      if (status === g.WAIT_FAILED) continue;
      const readStart = performance.now();
      g.bindBuffer(g.PIXEL_PACK_BUFFER, this.buffers[slot] as WebGLBuffer);
      g.getBufferSubData(g.PIXEL_PACK_BUFFER, 0, this.scratch);
      g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
      const done = performance.now();
      this.stats.frames += 1;
      const latency = done - (this.issuedAt[slot] as number);
      const first = this.stats.frames === 1;
      this.stats.latencyMs = first ? latency : this.stats.latencyMs * 0.95 + latency * 0.05;
      this.stats.readMs = first ? done - readStart : this.stats.readMs * 0.95 + (done - readStart) * 0.05;
      this.options.onFrame(this.scratch);
    }
  }

  /** Recreates the readback buffers (context restored); frames in flight are lost. */
  rebuild(): void {
    const g = this.gl.gl;
    this.buffers = [];
    for (let i = 0; i < RING; i++) {
      const buffer = g.createBuffer()!;
      g.bindBuffer(g.PIXEL_PACK_BUFFER, buffer);
      g.bufferData(g.PIXEL_PACK_BUFFER, this.bytes, g.STREAM_READ);
      this.buffers.push(buffer);
    }
    g.bindBuffer(g.PIXEL_PACK_BUFFER, null);
    this.fences.fill(null);
    this.pending.length = 0;
    this.next = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.pumpTimer !== null) clearTimeout(this.pumpTimer);
    const g = this.gl.gl;
    for (const fence of this.fences) if (fence) g.deleteSync(fence);
    for (const buffer of this.buffers) g.deleteBuffer(buffer);
    this.gl.untrack(this);
    this.gl.untrack(this.frame);
    this.gl.untrack(this.yuv);
  }
}

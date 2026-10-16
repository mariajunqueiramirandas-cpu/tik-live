/**
 * Runs on the audio rendering thread of a broadcast stage (ADR-0020): turns
 * the voice into 16-bit little-endian stereo PCM and posts it to the page in
 * 20 ms packets, which the page forwards to the broadcaster's encoder.
 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
declare const sampleRate: number;

class PcmTap extends AudioWorkletProcessor {
  private readonly packetFrames = Math.round(sampleRate / 50);
  private packet = new Int16Array(this.packetFrames * 2);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    // With nothing playing the input has no channels: that's silence, and it
    // still has to be sent so the audio timeline keeps pace with the video.
    const channels = inputs[0] ?? [];
    const left = channels[0];
    const right = channels[1] ?? left;
    const frames = left?.length ?? 128;
    for (let i = 0; i < frames; i++) {
      const l = left ? (left[i] as number) : 0;
      const r = right ? (right[i] as number) : 0;
      this.packet[this.filled++] = Math.max(-1, Math.min(1, l)) * 32767;
      this.packet[this.filled++] = Math.max(-1, Math.min(1, r)) * 32767;
      if (this.filled === this.packet.length) {
        this.port.postMessage(this.packet.buffer, [this.packet.buffer]);
        this.packet = new Int16Array(this.packetFrames * 2);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm-tap", PcmTap);

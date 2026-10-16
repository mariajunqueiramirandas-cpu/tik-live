"""16-bit PCM -> the file a reply carries: Ogg/Opus (what WhatsApp plays as a voice note) or WAV.

Encoders take the audio as the engine produces it, so encoding overlaps synthesis instead of
adding ~10 ms per second of audio after it."""

from __future__ import annotations

import io
import wave

import av
import numpy as np

FORMATS = {"ogg": "audio/ogg; codecs=opus", "wav": "audio/wav"}


class OggOpus:
    def __init__(self, rate: int, bitrate: int = 32000):
        self._buf = io.BytesIO()
        self._c = av.open(self._buf, "w", format="ogg")
        self._s = self._c.add_stream("libopus", rate=rate, layout="mono")
        self._s.bit_rate = bitrate
        self._s.codec_context.options = {"application": "voip"}  # tuned for speech
        self._rate, self._pts = rate, 0

    def write(self, pcm: np.ndarray) -> None:
        frame = av.AudioFrame.from_ndarray(np.ascontiguousarray(pcm, np.int16)[None], format="s16", layout="mono")
        frame.sample_rate, frame.pts = self._rate, self._pts
        self._pts += len(pcm)
        for packet in self._s.encode(frame):
            self._c.mux(packet)

    def finish(self) -> bytes:
        for packet in self._s.encode(None):
            self._c.mux(packet)
        self._c.close()
        return self._buf.getvalue()


class Wav:
    def __init__(self, rate: int):
        self._rate, self._parts = rate, []

    def write(self, pcm: np.ndarray) -> None:
        self._parts.append(np.ascontiguousarray(pcm, "<i2").tobytes())

    def finish(self) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(self._rate)
            w.writeframes(b"".join(self._parts))
        return buf.getvalue()


def encoder(fmt: str, rate: int, bitrate: int = 32000) -> OggOpus | Wav:
    return OggOpus(rate, bitrate) if fmt == "ogg" else Wav(rate)

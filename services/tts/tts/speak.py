"""Text -> 24 kHz PCM through the engine. Any number of request threads call speak() at once: the
engine batches every chunk in flight into its speech model's steps, so a long reply's chunks are
generated together and come back in order."""

from __future__ import annotations

import hashlib
import time
from collections.abc import Callable
from pathlib import Path

import numpy as np

from .text import Chunker, normalize

TEMPERATURE = 0.3  # the model's own default


class SpeakError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class Speaker:
    def __init__(self, engine, tokenizer, max_chunk_tokens: int = 50):
        self.engine = engine
        self.sample_rate = engine.sample_rate
        self.chunker = Chunker(
            lambda s: tokenizer.encode(s).ids, tokenizer.decode, max_chunk_tokens, engine.max_tokens
        )

    @classmethod
    def load(cls, engine, model_dir: str | Path) -> "Speaker":
        import tokenizers

        return cls(engine, tokenizers.Tokenizer.from_file(str(Path(model_dir) / "tokenizer.json")))

    def speak(
        self, text: str, voice: str, timeout: float, sink: Callable[[np.ndarray], None], seed: int | None = None
    ) -> tuple[int, int]:
        """Feeds the audio to sink as it is made -> (samples, chunks). The default seed follows the
        text and voice, so the same reply always sounds the same."""
        try:
            v = self.engine.voice_id(voice)
        except KeyError:
            raise SpeakError("unknown_voice") from None
        try:
            chunks = self.chunker.split(normalize(text))
        except ValueError:
            raise SpeakError("empty_text") from None
        if seed is None:
            seed = int.from_bytes(hashlib.sha256(f"{voice}\0{text}".encode()).digest()[:8], "little")
        deadline = time.monotonic() + timeout
        ids, samples = [], 0
        try:
            for i, c in enumerate(chunks):
                ids.append(self.engine.submit(c.tokens, v, TEMPERATURE, c.frames_after_eos, seed + i))
            buf = np.empty(self.sample_rate, np.int16)
            for sid in ids:
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise SpeakError("timeout")
                    n = self.engine.read(sid, buf, int(min(left, 1.0) * 1000) + 1)
                    if n > 0:
                        sink(buf[:n])
                        samples += n
                    elif n == -1:
                        break
                    elif n < -1:
                        raise SpeakError("synthesis_failed")
        except ValueError:  # the engine refused a chunk
            raise SpeakError("synthesis_failed") from None
        finally:
            for sid in ids:
                self.engine.release(sid)
        return samples, len(chunks)

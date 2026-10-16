"""ctypes binding of the C++ engine (engine/pocket.h). Calls release the GIL while they run."""

from __future__ import annotations

import ctypes
import os
from pathlib import Path

import numpy as np

_LIB_ENV = "TTS_ENGINE_LIB"
_DEFAULT_LIB = Path(__file__).resolve().parent.parent / "engine" / "build" / "libpocket.so"


class _Options(ctypes.Structure):
    _fields_ = [
        ("lm_threads", ctypes.c_int),
        ("mimi_threads", ctypes.c_int),
        ("max_batch", ctypes.c_int),
        ("max_tokens", ctypes.c_int),
        ("chunk", ctypes.c_int),
        ("isa", ctypes.c_char_p),
        ("speech_bits", ctypes.c_int),
    ]


def _load(path: str | None = None) -> ctypes.CDLL:
    lib = ctypes.CDLL(path or os.environ.get(_LIB_ENV) or str(_DEFAULT_LIB))
    vp, i32p, f32p, i16p = ctypes.c_void_p, ctypes.POINTER(ctypes.c_int32), ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_int16)
    sig = {
        "pk_open": (vp, [ctypes.c_char_p, ctypes.POINTER(_Options), ctypes.c_char_p, ctypes.c_int]),
        "pk_close": (None, [vp]),
        "pk_isa": (ctypes.c_char_p, [vp]),
        "pk_speech_bits": (ctypes.c_int, [vp]),
        "pk_decoder_mode": (ctypes.c_char_p, [vp]),
        "pk_sample_rate": (ctypes.c_int, [vp]),
        "pk_voice_count": (ctypes.c_int, [vp]),
        "pk_voice_name": (ctypes.c_char_p, [vp, ctypes.c_int]),
        "pk_max_tokens": (ctypes.c_int, [vp]),
        "pk_submit": (ctypes.c_int64, [vp, i32p, ctypes.c_int, ctypes.c_int, ctypes.c_float, ctypes.c_int, ctypes.c_uint64]),
        "pk_read": (ctypes.c_int, [vp, ctypes.c_int64, i16p, ctypes.c_int, ctypes.c_int]),
        "pk_release": (None, [vp, ctypes.c_int64]),
        "pk_stats": (None, [vp, i32p, i32p, i32p]),
        "pk_debug_generate": (ctypes.c_int, [vp, ctypes.c_int, i32p, ctypes.c_int, f32p, ctypes.c_int, ctypes.c_int, f32p, f32p, f32p, f32p]),
        "pk_debug_decode": (ctypes.c_int, [vp, f32p, ctypes.c_int, ctypes.c_int, f32p]),
        "pk_profile_dump": (None, []),
    }
    for name, (res, args) in sig.items():
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = res, args
    return lib


def _ptr(a: np.ndarray, ctype):
    return a.ctypes.data_as(ctypes.POINTER(ctype))


class Engine:
    """One loaded model. Thread-safe: requests from many threads are batched by the engine."""

    def __init__(
        self,
        model_path: str | Path,
        lm_threads: int = 1,
        mimi_threads: int = 1,
        max_batch: int = 8,
        max_tokens: int = 160,
        chunk: int = 8,
        isa: str | None = None,
        lib: str | None = None,
        speech_bits: int = 8,
    ):
        self._lib = _load(lib)
        opt = _Options(lm_threads, mimi_threads, max_batch, max_tokens, chunk, isa.encode() if isa else None, speech_bits)
        err = ctypes.create_string_buffer(512)
        self._h = self._lib.pk_open(str(model_path).encode(), ctypes.byref(opt), err, len(err))
        if not self._h:
            raise RuntimeError(err.value.decode() or "cannot open model")
        self.isa = self._lib.pk_isa(self._h).decode()
        self.speech_bits = self._lib.pk_speech_bits(self._h)
        self.decoder_mode = self._lib.pk_decoder_mode(self._h).decode()
        self.sample_rate = self._lib.pk_sample_rate(self._h)
        self.max_tokens = self._lib.pk_max_tokens(self._h)
        self.voices = [self._lib.pk_voice_name(self._h, i).decode() for i in range(self._lib.pk_voice_count(self._h))]

    def close(self) -> None:
        if self._h:
            self._lib.pk_close(self._h)
            self._h = None

    def __del__(self):
        self.close()

    def voice_id(self, name: str) -> int:
        try:
            return self.voices.index(name)
        except ValueError:
            raise KeyError(name) from None

    def submit(self, tokens: list[int], voice: int, temp: float = 0.3, frames_after_eos: int = 3, seed: int = 0) -> int:
        t = np.ascontiguousarray(tokens, dtype=np.int32)
        sid = self._lib.pk_submit(self._h, _ptr(t, ctypes.c_int32), len(t), voice, temp, frames_after_eos, seed & (2**64 - 1))
        if sid < 0:
            raise ValueError("rejected sequence")
        return sid

    def read(self, sid: int, buf: np.ndarray, timeout_ms: int = 1000) -> int:
        """Fills buf (int16) and returns the count; 0 = nothing yet, -1 = done, -2 = failed."""
        return self._lib.pk_read(self._h, sid, _ptr(buf, ctypes.c_int16), len(buf), timeout_ms)

    def release(self, sid: int) -> None:
        self._lib.pk_release(self._h, sid)

    def stats(self) -> tuple[int, int, int]:
        q, a, d = ctypes.c_int32(), ctypes.c_int32(), ctypes.c_int32()
        self._lib.pk_stats(self._h, ctypes.byref(q), ctypes.byref(a), ctypes.byref(d))
        return q.value, a.value, d.value

    # tests and benchmarks (engine opened with max_batch=0)
    def debug_generate(self, voice: int, tokens, noise: np.ndarray, frames_after_eos: int, d_model: int = 0, teacher=None):
        """-> (latents, eos logits, hidden states [steps][d_model] when d_model is given). With teacher
        latents, each step reads the teacher's previous latent and all len(noise) steps run."""
        t = np.ascontiguousarray(tokens, dtype=np.int32)
        noise = np.ascontiguousarray(noise, dtype=np.float32)
        tch = np.ascontiguousarray(teacher, dtype=np.float32) if teacher is not None else None
        steps, ldim = noise.shape
        lat = np.zeros((steps, ldim), np.float32)
        eos = np.full(steps, np.nan, np.float32)
        hid = np.zeros((steps, d_model), np.float32) if d_model else None
        n = self._lib.pk_debug_generate(self._h, voice, _ptr(t, ctypes.c_int32), len(t), _ptr(noise, ctypes.c_float), steps,
                                        frames_after_eos, _ptr(lat, ctypes.c_float), _ptr(eos, ctypes.c_float),
                                        _ptr(hid, ctypes.c_float) if hid is not None else None,
                                        _ptr(tch, ctypes.c_float) if tch is not None else None)
        if n < 0:
            raise RuntimeError("debug_generate failed")
        return (lat[:n], eos, hid) if d_model else (lat[:n], eos)

    def debug_decode(self, latents: np.ndarray, chunk: int, frame_samples: int = 1920) -> np.ndarray:
        lat = np.ascontiguousarray(latents, dtype=np.float32)
        out = np.zeros(len(lat) * frame_samples, np.float32)
        if self._lib.pk_debug_decode(self._h, _ptr(lat, ctypes.c_float), len(lat), chunk, _ptr(out, ctypes.c_float)) < 0:
            raise RuntimeError("debug_decode failed")
        return out

    def profile_dump(self) -> None:
        """Prints per-section engine times to stderr (needs PK_PROFILE=1) and resets them."""
        self._lib.pk_profile_dump()

"""The C++ engine against tts/reference.py on a tiny random model, on every instruction set this
CPU has. Needs engine/build/libpocket.so (make -C engine)."""

import os
import tempfile
import threading
import unittest
from pathlib import Path

import numpy as np

from tts import reference as ref
from tests import tiny
from tts.engine import Engine
from tts.gptq import round_to_nearest
from tts.pack import hadamard, pack, rotate

ALL_F32 = {"qkv", "o", "ff", "flow", "mimi"}
TOKENS = [3, 17, 5, 22, 9, 31, 2, 14, 8]


def isas() -> list[str]:
    out = []
    for isa in ("avx2", "avxvnni", "avx512", "amx"):
        try:
            Engine(Model.f32, max_batch=0, isa=isa).close()
            out.append(isa)
        except RuntimeError as e:
            if "lacks" not in str(e) and "refused" not in str(e):
                raise
    return out


def snr(x: np.ndarray, ref_: np.ndarray) -> float:
    return float(10 * np.log10(np.sum(ref_**2) / max(np.sum((x - ref_) ** 2), 1e-30)))


class Model:
    """Packed once for the module: float32 everywhere, as shipped (int8 and int4), and one that ends
    early."""

    f32 = q8 = eos = ""


def int4_weights(sd: dict) -> dict:
    """The transformer's matrices as the int4 model holds them, back in float32 and unrotated."""
    out = dict(sd)
    hd = CFG.d_model // CFG.heads
    for i in range(CFG.layers):
        f = f"flow_lm.transformer.layers.{i}."
        for j, k in enumerate(("self_attn.in_proj", "self_attn.out_proj", "linear1", "linear2")):
            w = sd[f + k + ".weight"].copy()
            if j == 0:
                w[: CFG.d_model] /= np.sqrt(hd)  # as pack scales the query rows
            wr, signs = rotate(w, 4 * i + j)
            q, s = round_to_nearest(wr)
            back = (hadamard(q.astype(np.float64) * s[:, None]) * signs).astype(np.float32)
            if j == 0:
                back[: CFG.d_model] *= np.sqrt(hd)
            out[f + k + ".weight"] = back
    return out


def setUpModule():
    global _dir, SD, CFG, VOICES, ISAS
    _dir = tempfile.TemporaryDirectory()
    SD, VOICES, CFG = tiny.model()
    for name, f32 in (("f32", ALL_F32), ("q8", set())):
        path = Path(_dir.name) / f"{name}.bin"
        pack(SD, VOICES, CFG, f32).write(path)
        setattr(Model, name, str(path))
    sd_eos, voices_eos, cfg_eos = tiny.model(eos_bias=100.0)
    Model.eos = str(Path(_dir.name) / "eos.bin")
    pack(sd_eos, voices_eos, cfg_eos, set()).write(Path(Model.eos))
    ISAS = isas()


def tearDownModule():
    _dir.cleanup()


class SpeechModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        steps = ref.max_frames(len(TOKENS))
        rng = np.random.default_rng(1)
        cls.noise = (rng.standard_normal((steps, CFG.ldim)) * np.sqrt(0.3)).astype(np.float32)
        cls.want = ref.generate(ref.FlowLM(SD, CFG), VOICES["bia"], TOKENS, cls.noise, frames_after_eos=0)
        # what the int4 model should say: the reference on its weights, so the error left is the rest's
        cls.want4 = ref.generate(ref.FlowLM(int4_weights(SD), CFG), VOICES["bia"], TOKENS, cls.noise, frames_after_eos=0)

    # Teacher forcing: every step reads the reference's previous latent, so the error is one step's,
    # without the drift of feeding back its own (the KV cache is float16 even in float32 models).
    def check(self, model: str, max_err: float, want: np.ndarray | None = None, speech_bits: int = 8):
        want = self.want if want is None else want
        for isa in ISAS:
            with self.subTest(isa=isa, model=model, speech_bits=speech_bits):
                e = Engine(model, max_batch=0, isa=isa, speech_bits=speech_bits)
                self.assertEqual(e.speech_bits, speech_bits)
                free, _ = e.debug_generate(e.voice_id("bia"), TOKENS, self.noise, frames_after_eos=0)
                self.assertEqual(free.shape, want.shape)
                got, _ = e.debug_generate(e.voice_id("bia"), TOKENS, self.noise, 0, teacher=want)
                self.assertLess(np.linalg.norm(got - want) / np.linalg.norm(want), max_err)

    def test_float32_matches_reference(self):
        self.check(Model.f32, 5e-4)  # measured 6e-5

    def test_int8_close_to_reference(self):
        self.check(Model.q8, 0.05)  # measured 1.4%

    def test_int4_runs_its_weights(self):
        self.check(Model.q8, 0.05, self.want4, speech_bits=4)  # measured 1.4%

    def test_int4_needs_a_file_with_it(self):
        with self.assertRaisesRegex(RuntimeError, "no int4 copy"):
            Engine(Model.f32, max_batch=0, speech_bits=4)


class DecoderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rng = np.random.default_rng(2)
        cls.lat = rng.standard_normal((20, CFG.ldim)).astype(np.float32)
        cls.want = ref.Mimi(SD, CFG).decode(cls.lat)

    def test_float32_matches_reference_in_any_chunking(self):
        os.environ["PK_MIMI_MODE"] = "f32"
        try:
            for isa in ISAS:
                e = Engine(Model.f32, max_batch=0, chunk=8, isa=isa)
                for chunk in (1, 3, 8):
                    with self.subTest(isa=isa, chunk=chunk):
                        got = e.debug_decode(self.lat, chunk)
                        # AMX runs the decoder in bfloat16; measured 117 dB, 44 dB with AMX
                        self.assertGreater(snr(got, self.want), 38 if isa == "amx" else 90)
        finally:
            del os.environ["PK_MIMI_MODE"]

    def test_int8_modes(self):
        for isa in ISAS:
            for mode in ("q12", "q8") if isa != "amx" else ("bf16",):
                with self.subTest(isa=isa, mode=mode):
                    if mode != "bf16":
                        os.environ["PK_MIMI_MODE"] = mode
                    try:
                        e = Engine(Model.q8, max_batch=0, chunk=8, isa=isa)
                    finally:
                        os.environ.pop("PK_MIMI_MODE", None)
                    self.assertEqual(e.decoder_mode, mode)
                    # measured 32-44 dB
                    self.assertGreater(snr(e.debug_decode(self.lat, 8), self.want), 26)


class StreamingTest(unittest.TestCase):
    def read_all(self, e: Engine, sid: int) -> np.ndarray:
        out, buf = [], np.empty(4096, np.int16)
        while (n := e.read(sid, buf, 5000)) != -1:
            self.assertGreaterEqual(n, 0)
            out.append(buf[:n].copy())
        e.release(sid)
        return np.concatenate(out)

    def test_batched_sequences_sound_as_alone(self):
        # 3 decoder threads: sequences decoded side by side, each on a single-threaded decoder
        for mimi_threads in (1, 3):
            with self.subTest(mimi_threads=mimi_threads):
                e = Engine(Model.q8, mimi_threads=mimi_threads, max_batch=4, chunk=4)
                jobs = [(TOKENS, "ana", 7), (TOKENS[:4], "bia", 8), (TOKENS[::-1], "ana", 9)]
                alone = [self.read_all(e, e.submit(t, e.voice_id(v), 0.3, 2, s)) for t, v, s in jobs]
                ids = [e.submit(t, e.voice_id(v), 0.3, 2, s) for t, v, s in jobs]
                together = [None] * len(ids)

                def read(i):
                    together[i] = self.read_all(e, ids[i])

                threads = [threading.Thread(target=read, args=(i,)) for i in range(len(ids))]
                [t.start() for t in threads]
                [t.join() for t in threads]
                for a, b in zip(alone, together):
                    self.assertEqual(len(a), len(b))
                    self.assertLessEqual(np.abs(a.astype(np.int32) - b).max(), 2)
                self.assertEqual(e.stats(), (0, 0, 0))
                e.close()

    def test_end_of_speech_keeps_frames_after_it(self):
        # eos fires at every step: speech stops at the earliest allowed step (6) plus the frames kept
        e = Engine(Model.eos, max_batch=2, chunk=4)
        for fae in (0, 3):
            audio = self.read_all(e, e.submit(TOKENS, 0, 0.3, fae, 1))
            self.assertEqual(len(audio), (6 + fae) * 1920)

    def test_rejects_bad_input_and_release_stops(self):
        e = Engine(Model.q8, max_batch=2, max_tokens=16)
        for tokens, voice in (([], 0), (list(range(17)), 0), (TOKENS, 2), (TOKENS, -1)):
            with self.assertRaises(ValueError):
                e.submit(tokens, voice)
        sid = e.submit(TOKENS, 0)
        e.release(sid)
        self.assertEqual(e.read(sid, np.empty(16, np.int16), 10), -2)
        self.read_all(e, e.submit(TOKENS, 1))  # still serving


if __name__ == "__main__":
    unittest.main()

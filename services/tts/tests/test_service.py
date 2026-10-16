import io
import json
import threading
import time
import unittest
import urllib.error
import urllib.request
import wave

import av
import numpy as np

from tts.server import Config, build, split_threads
from tts.speak import Speaker

RATE = 24000


class Tokens:
    def __init__(self, ids):
        self.ids = ids


class FakeTokenizer:
    def encode(self, s: str) -> Tokens:
        return Tokens([0] + [ord(c) for c in s])

    def decode(self, ids: list[int]) -> str:
        return "".join(chr(i) for i in ids if i)


class FakeEngine:
    """Each chunk speaks 0.1 s of a tone per token; mode "hang" never finishes, "fail" fails."""

    sample_rate, max_tokens = RATE, 100
    voices = ["alba", "rafael"]

    def __init__(self, mode: str = "ok"):
        self.mode = mode
        self.submitted, self.released = [], []
        self.gate = threading.Event()
        self.gate.set()
        self._audio = {}

    def voice_id(self, name: str) -> int:
        if name not in self.voices:
            raise KeyError(name)
        return self.voices.index(name)

    def submit(self, tokens, voice, temp=0.3, frames_after_eos=3, seed=0) -> int:
        sid = len(self.submitted) + 1
        self.submitted.append((list(tokens), voice, seed))
        n = len(tokens) * RATE // 10
        self._audio[sid] = (np.sin(np.arange(n) * 0.05) * 8000).astype(np.int16)
        return sid

    def read(self, sid, buf, timeout_ms) -> int:
        self.gate.wait()
        if self.mode == "fail":
            return -2
        if self.mode == "hang":
            time.sleep(timeout_ms / 1000)
            return 0
        a = self._audio[sid]
        if not len(a):
            return -1
        n = min(len(buf), len(a))
        buf[:n] = a[:n]
        self._audio[sid] = a[n:]
        return n

    def release(self, sid) -> None:
        self.released.append(sid)


def serve(engine: FakeEngine, **env):
    cfg = Config({"TTS_SECRET": "s3cret", "TTS_ADDR": "127.0.0.1:0", "TTS_THREADS": "2", **env})
    httpd, app = build(cfg, Speaker(engine, FakeTokenizer()), {"isa": "fake", "voices": engine.voices})
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    app.ready = True
    return httpd, app, f"http://127.0.0.1:{httpd.server_address[1]}"


def post(url: str, body, secret: str = "s3cret") -> tuple[int, dict, bytes]:
    data = body if isinstance(body, bytes) else json.dumps(body).encode()
    req = urllib.request.Request(url + "/v1/speak", data=data, method="POST", headers={"authorization": f"Bearer {secret}"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


class ServiceTest(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.httpd, self.app, self.url = serve(self.engine)

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def test_wav(self):
        status, headers, body = post(self.url, {"text": "Oi. Tudo bem?", "format": "wav"})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/wav")
        with wave.open(io.BytesIO(body)) as w:
            self.assertEqual((w.getframerate(), w.getnchannels(), w.getsampwidth()), (RATE, 1, 2))
            frames = w.getnframes()
        # one chunk: the marker plus the prompt's characters, 0.1 s each
        self.assertEqual(frames, (len("Oi. Tudo bem?") + 1) * RATE // 10)
        self.assertAlmostEqual(float(headers["x-tts-seconds"]), frames / RATE, places=3)
        self.assertEqual(self.engine.released, [1])

    def test_ogg_opus_is_the_default(self):
        status, headers, body = post(self.url, {"text": "Seu pedido saiu para entrega."})
        self.assertEqual(status, 200)
        self.assertEqual(headers["content-type"], "audio/ogg; codecs=opus")
        with av.open(io.BytesIO(body)) as c:
            s = c.streams.audio[0]
            self.assertEqual((s.codec_context.name, s.codec_context.channels), ("opus", 1))
            seconds = sum(f.samples for f in c.decode(s)) / s.codec_context.sample_rate
        self.assertAlmostEqual(seconds, float(headers["x-tts-seconds"]), delta=0.03)

    def test_voice_text_and_seed(self):
        post(self.url, {"text": "R$ 10", "voice": "alba", "format": "wav"})
        post(self.url, {"text": "R$ 10", "voice": "alba", "format": "wav"})
        post(self.url, {"text": "R$ 10", "voice": "alba", "format": "wav", "seed": 42})
        (t1, v1, s1), (_, _, s2), (_, _, s3) = self.engine.submitted
        self.assertEqual(FakeTokenizer().decode(t1), "Dez reais.")
        self.assertEqual(v1, 0)
        self.assertEqual(s1, s2)  # the same reply sounds the same
        self.assertEqual(s3, 42)

    def test_long_text_comes_back_in_order(self):
        text = " ".join(f"Frase número {i}." for i in range(1, 13))
        status, _, body = post(self.url, {"text": text, "format": "wav"})
        self.assertEqual(status, 200)
        self.assertGreater(len(self.engine.submitted), 1)
        want = sum((len(t) * RATE // 10 for t, _, _ in self.engine.submitted))
        with wave.open(io.BytesIO(body)) as w:
            self.assertEqual(w.getnframes(), want)

    def test_bad_requests(self):
        for body, status, code in (
            (b"{nope", 400, "bad_request"),
            ({"voice": "alba"}, 400, "bad_request"),
            ({"text": 5}, 400, "bad_request"),
            ({"text": "oi", "format": "mp3"}, 400, "bad_request"),
            ({"text": "oi", "seed": -1}, 400, "bad_request"),
            ({"text": "oi", "seed": True}, 400, "bad_request"),
            ({"text": "oi", "voice": "nobody"}, 400, "unknown_voice"),
            ({"text": "😀 🎉 *"}, 400, "empty_text"),
            ({"text": "a" * 2001}, 413, "too_long"),
            (b"x" * (64 * 1024 + 1), 413, "too_big"),
        ):
            with self.subTest(body=str(body)[:40]):
                got, _, data = post(self.url, body)
                self.assertEqual((got, json.loads(data)["error"]), (status, code))
        self.assertEqual(self.engine.submitted, [])

    def test_auth(self):
        self.assertEqual(post(self.url, {"text": "oi"}, secret="wrong")[0], 401)
        with urllib.request.urlopen(self.url + "/healthz") as r:
            health = json.loads(r.read())
        self.assertEqual((health["ok"], health["active"], health["voices"]), (True, 0, ["alba", "rafael"]))


class FailureTest(unittest.TestCase):
    def run_with(self, engine: FakeEngine, **env):
        httpd, app, url = serve(engine, **env)
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        return app, url

    def test_not_configured_and_warming_up(self):
        engine = FakeEngine()
        cfg = Config({"TTS_ADDR": "127.0.0.1:0"})
        httpd, app = build(cfg, Speaker(engine, FakeTokenizer()), {})
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        url = f"http://127.0.0.1:{httpd.server_address[1]}"
        self.assertEqual(post(url, {"text": "oi"})[0], 503)
        with self.assertRaises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(url + "/healthz")
        self.assertEqual(e.exception.code, 503)

    def test_engine_failure(self):
        engine = FakeEngine("fail")
        _, url = self.run_with(engine)
        status, _, body = post(url, {"text": "Oi. Tudo bem?"})
        self.assertEqual((status, json.loads(body)["error"]), (500, "synthesis_failed"))
        self.assertEqual(engine.released, [1])

    def test_timeout_releases_the_chunks(self):
        engine = FakeEngine("hang")
        _, url = self.run_with(engine, TTS_REQUEST_TIMEOUT_S="0.3")
        status, _, body = post(url, {"text": "Oi. Tudo bem? " * 8})
        self.assertEqual((status, json.loads(body)["error"]), (503, "timeout"))
        self.assertEqual(sorted(engine.released), list(range(1, len(engine.submitted) + 1)))

    def test_overloaded(self):
        engine = FakeEngine()
        engine.gate.clear()
        app, url = self.run_with(engine, TTS_MAX_ACTIVE="1")
        first = threading.Thread(target=post, args=(url, {"text": "oi"}))
        first.start()
        while app.active == 0:
            time.sleep(0.01)
        status, _, body = post(url, {"text": "oi"})
        self.assertEqual((status, json.loads(body)["error"]), (503, "overloaded"))
        engine.gate.set()
        first.join()
        self.assertEqual(app.active, 0)


class ThreadsTest(unittest.TestCase):
    def test_split(self):
        # measured on AVX2: the decoder is the bottleneck past two cores
        self.assertEqual([split_threads(n) for n in (1, 2, 3, 4, 6)], [(1, 1), (1, 1), (1, 2), (2, 2), (3, 3)])


if __name__ == "__main__":
    unittest.main()

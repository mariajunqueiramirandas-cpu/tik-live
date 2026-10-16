"""HTTP front of the engine. Internal only: the app is the one caller.

  POST /v1/speak   Authorization: Bearer $TTS_SECRET
                   body {"text", "voice"?, "format"?: "ogg" | "wav", "seed"?}
                   -> audio/ogg (Opus, mono) or audio/wav, 24 kHz; x-tts-seconds: its length
  GET  /healthz    -> 200 once the model is loaded and warm: {ok, active, isa, decoder, speech_bits, voice, voices}

Texts are what the host says on stream: never logged, never kept.
"""

from __future__ import annotations

import hmac
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from . import audio
from .cpus import cpu_budget
from .speak import SpeakError, Speaker

MAX_BODY = 64 * 1024


def log(level: str, msg: str, **fields) -> None:
    sys.stdout.write(json.dumps({"level": level, "msg": msg, "t": round(time.time(), 3), **fields}) + "\n")
    sys.stdout.flush()


def split_threads(n: int) -> tuple[int, int]:
    """Cores -> (speech model, audio decoder) threads; the two run at once. Alone, a reply's speech
    model and decoder take about the same time; under load the decoder's share grows (its work is
    per second of audio, the model's mostly per step), so it gets the odd core."""
    lm = max(1, n // 2)
    return lm, max(1, n - lm)


class Config:
    def __init__(self, env: dict[str, str]):
        self.secret = env.get("TTS_SECRET", "")
        host, _, port = env.get("TTS_ADDR", "0.0.0.0:8793").rpartition(":")
        self.addr = (host or "0.0.0.0", int(port))
        self.model_dir = env.get("TTS_MODEL_DIR", "/models")
        self.threads = int(env.get("TTS_THREADS", "0")) or cpu_budget()
        self.max_batch = int(env.get("TTS_MAX_BATCH", "8"))
        self.max_active = int(env.get("TTS_MAX_ACTIVE", "16"))  # requests in flight; more get 503
        self.max_chars = int(env.get("TTS_MAX_CHARS", "2000"))
        self.request_timeout = float(env.get("TTS_REQUEST_TIMEOUT_S", "120"))
        self.voice = env.get("TTS_VOICE", "rafael")
        self.bitrate = int(env.get("TTS_OPUS_BITRATE", "32000"))
        self.isa = env.get("TTS_ISA") or None  # avx2 | avxvnni | avx512 | amx; default: the best the CPU has
        self.speech_bits = int(env.get("TTS_SPEECH_BITS", "4"))  # the speech model's weights: 4 or 8


class App:
    def __init__(self, cfg: Config, speaker: Speaker, info: dict):
        self.cfg = cfg
        self.speaker = speaker
        self.info = info
        self.ready = False
        self.slots = threading.BoundedSemaphore(cfg.max_active)
        self._active = 0
        self._lock = threading.Lock()

    def enter(self) -> bool:
        if not self.slots.acquire(blocking=False):
            return False
        with self._lock:
            self._active += 1
        return True

    def leave(self) -> None:
        with self._lock:
            self._active -= 1
        self.slots.release()

    @property
    def active(self) -> int:
        with self._lock:
            return self._active


class Handler(BaseHTTPRequestHandler):
    server_version = "vendua-tts"
    protocol_version = "HTTP/1.1"
    timeout = 30  # per socket read: a stalled client can't hold a thread forever
    app: App

    def log_message(self, format, *args):  # noqa: A002 — stdlib signature
        pass

    def _send(self, status: int, body: bytes, ctype: str, headers: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, body: dict) -> None:
        self._send(status, json.dumps(body, ensure_ascii=False).encode(), "application/json; charset=utf-8")

    def _fail(self, status: int, code: str) -> tuple[int, str]:
        self._json(status, {"error": code})
        return status, code

    def do_GET(self):
        if urlsplit(self.path).path != "/healthz":
            return self._fail(404, "not_found")
        if not self.app.ready:
            return self._fail(503, "warming_up")
        self._json(200, {"ok": True, "active": self.app.active, **self.app.info})

    def do_POST(self):
        started = time.monotonic()
        if urlsplit(self.path).path != "/v1/speak":
            self.close_connection = True
            return self._fail(404, "not_found")
        stats: dict = {}
        status, code = self._speak(stats)
        log(
            "info" if status < 500 else "warn",
            "speak",
            status=status,
            code=code,
            ms=round((time.monotonic() - started) * 1000),
            **stats,
        )

    def _speak(self, stats: dict) -> tuple[int, str]:
        cfg = self.app.cfg
        if not cfg.secret:
            self.close_connection = True
            return self._fail(503, "not_configured")
        auth = self.headers.get("authorization", "")
        if not hmac.compare_digest(auth.encode(), f"Bearer {cfg.secret}".encode()):
            self.close_connection = True
            return self._fail(401, "unauthorized")
        if not self.app.ready:
            self.close_connection = True
            return self._fail(503, "warming_up")
        try:
            length = int(self.headers.get("content-length", ""))
        except ValueError:
            self.close_connection = True
            return self._fail(411, "length_required")
        if length > MAX_BODY or length < 0:
            self.close_connection = True
            return self._fail(413, "too_big")
        body = self.rfile.read(length)
        if len(body) != length:
            self.close_connection = True
            return self._fail(400, "short_body")
        try:
            req = json.loads(body)
            text, voice = req["text"], req.get("voice") or cfg.voice
            fmt, seed = req.get("format", "ogg"), req.get("seed")
            if not isinstance(text, str) or not isinstance(voice, str) or fmt not in audio.FORMATS:
                raise ValueError
            if seed is not None and (type(seed) is not int or not 0 <= seed < 2**63):
                raise ValueError
        except (ValueError, KeyError, TypeError, UnicodeDecodeError):
            return self._fail(400, "bad_request")
        stats["chars"] = len(text)
        if len(text) > cfg.max_chars:
            return self._fail(413, "too_long")
        if not self.app.enter():
            return self._fail(503, "overloaded")
        rate = self.app.speaker.sample_rate
        try:
            out = audio.encoder(fmt, rate, cfg.bitrate)
            samples, chunks = self.app.speaker.speak(text, voice, cfg.request_timeout, out.write, seed)
            data = out.finish()
        except SpeakError as e:
            return self._fail({"unknown_voice": 400, "empty_text": 400, "timeout": 503}.get(e.code, 500), e.code)
        except Exception as err:  # noqa: BLE001
            log("error", "synthesis failed", err=repr(err)[:300])
            return self._fail(500, "synthesis_failed")
        finally:
            self.app.leave()
        stats.update(chunks=chunks, audio_s=round(samples / rate, 2))
        self._send(200, data, audio.FORMATS[fmt], {"x-tts-seconds": f"{samples / rate:.3f}"})
        return 200, "ok"


def build(cfg: Config, speaker: Speaker, info: dict) -> tuple[ThreadingHTTPServer, App]:
    app = App(cfg, speaker, info)
    handler = type("BoundHandler", (Handler,), {"app": app})
    httpd = ThreadingHTTPServer(cfg.addr, handler)
    httpd.daemon_threads = True
    return httpd, app


def serve(cfg: Config) -> None:
    from pathlib import Path

    from .engine import Engine

    t = time.monotonic()
    lm, mimi = split_threads(cfg.threads)
    engine = Engine(Path(cfg.model_dir) / "pocket.bin", lm, mimi, cfg.max_batch, isa=cfg.isa, speech_bits=cfg.speech_bits)
    speaker = Speaker.load(engine, cfg.model_dir)
    if cfg.voice not in engine.voices:
        sys.exit(f"TTS_VOICE={cfg.voice} is not in the model: {', '.join(engine.voices)}")
    info = {
        "isa": engine.isa,
        "decoder": engine.decoder_mode,
        "speech_bits": engine.speech_bits,
        "voice": cfg.voice,
        "voices": sorted(engine.voices),
    }
    httpd, app = build(cfg, speaker, info)
    threading.Thread(target=httpd.serve_forever, name="http", daemon=True).start()
    speaker.speak("Olá! Tudo pronto por aqui.", cfg.voice, 60, lambda pcm: None)  # pages the weights in
    app.ready = True
    log(
        "info",
        "ready",
        addr=f"{cfg.addr[0]}:{cfg.addr[1]}",
        threads=f"{lm}+{mimi}",
        isa=engine.isa,
        decoder=engine.decoder_mode,
        speech_bits=engine.speech_bits,
        load_s=round(time.monotonic() - t, 1),
        secret=bool(cfg.secret),
    )
    threading.Event().wait()


if __name__ == "__main__":
    serve(Config(dict(os.environ)))

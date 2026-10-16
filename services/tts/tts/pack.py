"""Packs Pocket TTS weights (safetensors) into the C++ engine's model file.

  python -m tts.pack <model.safetensors> <voices dir> <out.bin> [--f32 <names>] [--int4 gptq|rtn|none]

Everything the engine would otherwise do per request is done here, once:

- Matrices the speech model reads per frame become int8 with one scale per output row, laid out
  for VNNI: blocks of 16 rows x 4 columns, 64 bytes, so one vpdpbusd consumes one block. Each row
  also gets the sum of its int8 weights, which undoes the activations' zero point.
- The transformer's and flow head's matrices are rotated first (QuaRot): W becomes W D H / K, with H
  a Hadamard matrix and D random signs, and the engine turns each input x into x D H as it
  quantizes it. The product is unchanged, and neither side keeps the outliers that set its scale.
- The transformer's matrices are also stored as int4 (one scale per row), quantized by GPTQ on
  inputs from calibration replies (tts/gptq.py). The engine runs int4 or int8 (TTS_SPEECH_BITS).
- The audio decoder's transformer and first conv are int8 the same way, and also float32 for
  CPUs with AMX, which run the whole decoder in bfloat16. Its later convs stay float32, packed in
  panels of 32 columns: int8 there puts audible noise into pauses.
  Convolutions become GEMMs over time-major buffers: a causal conv's weights are ordered
  [tap][in] so the im2col row of time t is the contiguous slice t-k+1..t of its input, and a
  transposed conv with kernel 2s is a 2-tap conv whose s phases are output columns.
- Constant folding: the attention scale goes into the query rows, Mimi's layer scales into the
  rows of the matrices before them, the latent denormalization into Mimi's input projection, and
  the flow head's time embedding (s=0, t=1 for a 1-step LSD decode) into its conditioning bias.
  The flow head's seven adaLN projections, which all read the same input, become one matrix.
- Predefined voices: their KV caches as float16.

The engine maps the file and checks every name, shape and the format version.
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

import numpy as np

from . import gptq
from .config import ModelConfig
from .weights import read_safetensors

MAGIC = b"PKTTS\0\0\0"
VERSION = 2
ALIGN = 64

# dtype codes shared with engine/model.h; U4 is two 4-bit codes per byte
F32, F16, I8, I32, U4 = 0, 1, 2, 3, 4
_CODES = {np.float32: F32, np.float16: F16, np.int8: I8, np.int32: I32, np.uint8: U4}
NAME_LEN = 56
# int32 fields of the header, in engine/model.h's order
CONFIG_FIELDS = (
    "d_model", "heads", "layers", "ff", "ldim", "vocab", "flow_dim", "flow_depth",
    "m_dim", "m_heads", "m_layers", "m_ff", "m_context", "n_filters", "n_residual",
    "kernel", "res_kernel", "last_kernel", "upsample", "sample_rate",
)
MAX_RATIOS = 4


def quantize_rows(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetric int8, one scale per output row."""
    amax = np.abs(w).max(axis=1)
    scale = np.where(amax > 0, amax / 127.0, 1.0).astype(np.float32)
    q = np.clip(np.rint(w / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale


def hadamard(a: np.ndarray) -> np.ndarray:
    """a @ H along the last axis, H the Sylvester Hadamard matrix (unnormalized) the engine uses."""
    n = a.shape[-1]
    h = 1
    while h < n:
        a = a.reshape(*a.shape[:-1], n // (2 * h), 2, h)
        a = np.stack([a[..., 0, :] + a[..., 1, :], a[..., 0, :] - a[..., 1, :]], axis=-2)
        a = a.reshape(*a.shape[:-3], n)
        h *= 2
    return a


def rotate(w: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """W [N, K] -> (W D H / K, signs): the engine multiplies inputs by D H, and H H = K I."""
    k = w.shape[1]
    signs = np.random.default_rng(seed).choice(np.array([-1.0, 1.0], np.float32), k)
    return (hadamard(w.astype(np.float64) * signs) / k).astype(np.float32), signs


def int4_layout(q: np.ndarray) -> np.ndarray:
    """[N, K] int4 -> [N/16, K/8, 64] bytes of codes q + 8: per 8 k, 16 columns x 4 bytes, byte j of a
    column holding k j (low nibble) and k j + 4 (high)."""
    n, k = q.shape
    assert n % 16 == 0 and k % 32 == 0, (n, k)
    u = (q.astype(np.int16) + 8).astype(np.uint8).reshape(n // 16, 16, k // 8, 2, 4).transpose(0, 2, 1, 4, 3)
    return np.ascontiguousarray(u[..., 0] | (u[..., 1] << 4))


def vnni_layout(q: np.ndarray) -> np.ndarray:
    """[N, K] int8 -> [N/16, K/4, 16, 4]: one 64-byte block per vpdpbusd."""
    n, k = q.shape
    assert n % 16 == 0 and k % 4 == 0, (n, k)
    return np.ascontiguousarray(q.reshape(n // 16, 16, k // 4, 4).transpose(0, 2, 1, 3))


def panel_layout(b: np.ndarray) -> np.ndarray:
    """GEMM right-hand side [K, N] float32 -> [N/32, K, 32]."""
    k, n = b.shape
    assert n % 32 == 0, (k, n)
    return np.ascontiguousarray(b.reshape(k, n // 32, 32).transpose(1, 0, 2)).astype(np.float32)


class Packer:
    def __init__(self, cfg: ModelConfig):
        self.cfg = cfg
        self.tensors: list[tuple[str, np.ndarray, tuple[int, ...]]] = []

    def raw(self, name: str, a: np.ndarray, shape: tuple[int, ...] | None = None):
        assert len(name) < NAME_LEN, name
        assert len(shape if shape is not None else a.shape) <= 4, name
        a = np.ascontiguousarray(a)
        self.tensors.append((name, a, tuple(shape if shape is not None else a.shape)))

    def linear_q8(self, name: str, w: np.ndarray, bias: np.ndarray | None = None, rot: int | None = None):
        """y = x @ w.T (+ bias); w [N, K]. rot: seed of the input's rotation, if any."""
        if rot is not None:
            w, signs = rotate(w, rot)
            self.raw(name + ".r", signs)
        q, scale = quantize_rows(w.astype(np.float32))
        n, k = w.shape
        self.raw(name + ".q", vnni_layout(q), (n, k))
        self.raw(name + ".s", scale)
        self.raw(name + ".z", q.astype(np.int32).sum(axis=1).astype(np.int32))
        if bias is not None:
            self.raw(name + ".b", bias.astype(np.float32))

    def linear_q4(self, name: str, q: np.ndarray, scale: np.ndarray):
        """The int4 copy of a rotated int8 linear (linear_q8 with rot), sharing its rotation and bias:
        W D H / K = scale * q."""
        n, k = q.shape
        self.raw(name + ".u", int4_layout(q), (n, k))
        self.raw(name + ".s4", scale.astype(np.float32))

    def linear_f32(self, name: str, w: np.ndarray, bias: np.ndarray | None = None):
        n, k = w.shape
        self.raw(name + ".p", panel_layout(w.T.astype(np.float32)), (n, k))
        if bias is not None:
            self.raw(name + ".b", bias.astype(np.float32))

    def linear(self, name: str, w, bias=None, f32: bool = False, rot: int | None = None):
        if f32:
            self.linear_f32(name, w, bias)
        else:
            self.linear_q8(name, w, bias, rot)

    def linear_both(self, name: str, w, bias=None, f32: bool = False):
        """int8 for the VNNI kernels, plus the float32 panels AMX converts to bfloat16."""
        if not f32:
            self.linear_q8(name, w, bias)
        self.linear_f32(name, w, bias if f32 else None)  # the bias is shared

    def write(self, path: Path):
        cfg = self.cfg
        head = bytearray(MAGIC)
        head += struct.pack("<I", VERSION)
        head += struct.pack(f"<{len(CONFIG_FIELDS)}i", *(int(getattr(cfg, f)) for f in CONFIG_FIELDS))
        ratios = list(cfg.ratios) + [0] * (MAX_RATIOS - len(cfg.ratios))
        head += struct.pack(f"<{MAX_RATIOS + 1}i", len(cfg.ratios), *ratios)
        head += struct.pack("<2f", cfg.max_period, cfg.m_max_period)
        head += struct.pack("<I", len(self.tensors))
        entry = struct.Struct(f"<{NAME_LEN}sII4qQQ")
        offset = len(head) + entry.size * len(self.tensors)
        offset += -offset % ALIGN
        entries, blobs = [], []
        for name, a, shape in self.tensors:
            dims = list(shape) + [0] * (4 - len(shape))
            data = a.tobytes()
            entries.append(entry.pack(name.encode(), _CODES[a.dtype.type], len(shape), *dims, offset, len(data)))
            blobs.append((offset, data))
            offset += len(data)
            offset += -offset % ALIGN
        out = bytearray(head)
        for e in entries:
            out += e
        for off, data in blobs:
            out += b"\0" * (off - len(out))
            out += data
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_bytes(out)
        tmp.replace(path)


def time_constant(sd: dict[str, np.ndarray]) -> np.ndarray:
    """(te0(s=0) + te1(t=1)) / 2 of the flow head, in float32 as the model computes it."""

    def te(i: int, t: float) -> np.ndarray:
        p = f"flow_lm.flow_net.time_embed.{i}."
        args = np.float32(t) * sd[p + "freqs"]
        e = np.concatenate([np.cos(args), np.sin(args)]).astype(np.float32)
        h = e @ sd[p + "mlp.0.weight"].T + sd[p + "mlp.0.bias"]
        h = (h / (1 + np.exp(-h))).astype(np.float32)
        h = h @ sd[p + "mlp.2.weight"].T + sd[p + "mlp.2.bias"]
        return (h * (sd[p + "mlp.3.alpha"] / np.sqrt(h.var(ddof=1) + np.float32(1e-5)))).astype(np.float32)

    return ((te(0, 0.0) + te(1, 1.0)) / np.float32(2)).astype(np.float32)


def pack(
    sd: dict[str, np.ndarray],
    voices: dict[str, dict[str, np.ndarray]],
    cfg: ModelConfig,
    f32: set[str],
    rotated: bool = True,
    int4: bool = True,
    calib: dict[int, np.ndarray] | None = None,
) -> Packer:
    """int4: also store the transformer's matrices as int4, by GPTQ on calib (gptq.calibrate's
    inputs) or, without it, by rounding to nearest."""
    p = Packer(cfg)
    g = lambda k: sd[k].astype(np.float32)
    hd = cfg.d_model // cfg.heads
    p.raw("lut", g("flow_lm.conditioner.embed.weight"))
    p.raw("bos", g("flow_lm.bos_emb"))
    p.linear_f32("in", g("flow_lm.input_linear.weight"))
    for i in range(cfg.layers):
        f = f"flow_lm.transformer.layers.{i}."
        qkv = g(f + "self_attn.in_proj.weight").copy()
        qkv[: cfg.d_model] *= np.float32(1 / np.sqrt(hd))  # a power of two for 64-wide heads
        p.raw(f"l{i}.n1.w", g(f + "norm1.weight"))
        p.raw(f"l{i}.n1.b", g(f + "norm1.bias"))

        def lin(j: int, kind: str, w: np.ndarray):
            name, seed = f"l{i}.{('qkv', 'o', 'ff1', 'ff2')[j]}", 4 * i + j
            p.linear(name, w, f32=kind in f32, rot=seed if rotated else None)
            if int4 and rotated and kind not in f32:
                wr, signs = rotate(w, seed)
                q, s = gptq.quantize(wr, hadamard(calib[seed] * signs)) if calib else gptq.round_to_nearest(wr)
                p.linear_q4(name, q, s)

        lin(0, "qkv", qkv)
        lin(1, "o", g(f + "self_attn.out_proj.weight"))
        p.raw(f"l{i}.n2.w", g(f + "norm2.weight"))
        p.raw(f"l{i}.n2.b", g(f + "norm2.bias"))
        lin(2, "ff", g(f + "linear1.weight"))
        lin(3, "ff", g(f + "linear2.weight"))
    p.raw("on.w", g("flow_lm.out_norm.weight"))
    p.raw("on.b", g("flow_lm.out_norm.bias"))
    p.raw("eos.w", g("flow_lm.out_eos.weight")[0])
    p.raw("eos.b", g("flow_lm.out_eos.bias"))

    fl = "flow_lm.flow_net."
    flow32 = "flow" in f32
    frot = (lambda seed: seed) if rotated else (lambda seed: None)
    p.linear("f.cond", g(fl + "cond_embed.weight"), g(fl + "cond_embed.bias") + time_constant(sd), f32=flow32, rot=frot(100))
    p.linear_f32("f.in", g(fl + "input_proj.weight"), g(fl + "input_proj.bias"))
    ada_w = [g(f"{fl}res_blocks.{i}.adaLN_modulation.1.weight") for i in range(cfg.flow_depth)]
    ada_b = [g(f"{fl}res_blocks.{i}.adaLN_modulation.1.bias") for i in range(cfg.flow_depth)]
    ada_w.append(g(fl + "final_layer.adaLN_modulation.1.weight"))
    ada_b.append(g(fl + "final_layer.adaLN_modulation.1.bias"))
    p.linear("f.ada", np.concatenate(ada_w), np.concatenate(ada_b), f32=flow32, rot=frot(101))
    for i in range(cfg.flow_depth):
        b = f"{fl}res_blocks.{i}."
        p.raw(f"f{i}.ln.w", g(b + "in_ln.weight"))
        p.raw(f"f{i}.ln.b", g(b + "in_ln.bias"))
        p.linear(f"f{i}.m0", g(b + "mlp.0.weight"), g(b + "mlp.0.bias"), f32=flow32, rot=frot(102 + 2 * i))
        p.linear(f"f{i}.m2", g(b + "mlp.2.weight"), g(b + "mlp.2.bias"), f32=flow32, rot=frot(103 + 2 * i))
    p.linear_f32("f.out", g(fl + "final_layer.linear.weight"), g(fl + "final_layer.linear.bias"))

    # Mimi: latent denormalization folded into the input projection
    wq = g("mimi.quantizer.output_proj.weight")[:, :, 0]
    p.linear_f32("m.in", wq * g("flow_lm.emb_std")[None, :], wq @ g("flow_lm.emb_mean"))
    p.raw("m.up", np.ascontiguousarray(g("mimi.upsample.convtr.convtr.weight")[:, 0, :].T))  # [2s, C]
    mh = cfg.m_dim // cfg.m_heads
    m32 = "mimi" in f32
    for i in range(cfg.m_layers):
        f = f"mimi.decoder_transformer.transformer.layers.{i}."
        qkv = g(f + "self_attn.in_proj.weight").copy()
        qkv[: cfg.m_dim] *= np.float32(1 / np.sqrt(mh))
        p.raw(f"ml{i}.n1.w", g(f + "norm1.weight"))
        p.raw(f"ml{i}.n1.b", g(f + "norm1.bias"))
        p.linear_both(f"ml{i}.qkv", qkv, f32=m32)
        p.linear_both(f"ml{i}.o", g(f + "self_attn.out_proj.weight") * g(f + "layer_scale_1.scale")[:, None], f32=m32)
        p.raw(f"ml{i}.n2.w", g(f + "norm2.weight"))
        p.raw(f"ml{i}.n2.b", g(f + "norm2.bias"))
        p.linear_both(f"ml{i}.ff1", g(f + "linear1.weight"), f32=m32)
        p.linear_both(f"ml{i}.ff2", g(f + "linear2.weight") * g(f + "layer_scale_2.scale")[:, None], f32=m32)

    d = "mimi.decoder.model."

    def conv(name: str, key: str, f32: bool = True):
        w = g(key + ".weight")  # [Cout, Cin, k] -> [Cout, k*Cin], column index tap*Cin + in
        cout, cin, k = w.shape
        p.linear_both(name, w.transpose(0, 2, 1).reshape(cout, k * cin), g(key + ".bias"), f32=f32)

    def convtr(name: str, key: str, s: int):
        w = g(key + ".weight")  # [Cin, Cout, 2s]; A row [x(t-1), x(t)], column r*Cout + out
        cin, cout, k = w.shape
        assert k == 2 * s
        bm = np.empty((2 * cin, s * cout), np.float32)
        for r in range(s):
            bm[:cin, r * cout : (r + 1) * cout] = w[:, :, r + s]
            bm[cin:, r * cout : (r + 1) * cout] = w[:, :, r]
        p.raw(name + ".p", panel_layout(bm), (s * cout, 2 * cin))
        p.raw(name + ".b", np.tile(g(key + ".bias"), s))

    conv("c0", f"{d}0.conv", f32=m32)
    idx = 1  # SEANet: [conv, (ELU, convtr, resblock * n) per ratio, ELU, conv]
    for j, ratio in enumerate(cfg.ratios):
        convtr(f"u{j}", f"{d}{idx + 1}.convtr", ratio)
        for r in range(cfg.n_residual):
            conv(f"r{j}.{r}.a", f"{d}{idx + 2 + r}.block.1.conv")
            conv(f"r{j}.{r}.b", f"{d}{idx + 2 + r}.block.3.conv")
        idx += 2 + cfg.n_residual
    w = g(f"{d}{idx + 1}.conv.weight")  # [1, Cin, k] -> [k*Cin], tap-major like the convs
    p.raw("cl.w", np.ascontiguousarray(w[0].T.reshape(-1)))
    p.raw("cl.b", g(f"{d}{idx + 1}.conv.bias"))

    for name, v in sorted(voices.items()):
        n = int(v["transformer.layers.0.self_attn/offset"][0])
        kv = np.stack([v[f"transformer.layers.{i}.self_attn/cache"][:, 0, :n] for i in range(cfg.layers)])
        p.raw(f"voice.{name}", kv.reshape(cfg.layers, 2, n, cfg.d_model).astype(np.float16))
    return p


def load_voices(folder: Path) -> dict[str, dict[str, np.ndarray]]:
    return {f.stem: read_safetensors(f) for f in sorted(folder.glob("*.safetensors"))}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("weights")
    ap.add_argument("voices")
    ap.add_argument("out")
    ap.add_argument("--f32", default="", help="comma list of qkv,o,ff,flow,mimi kept in float32")
    ap.add_argument("--no-rotate", action="store_true", help="int8 transformer matrices without the Hadamard rotation")
    ap.add_argument("--int4", default="gptq", choices=("gptq", "rtn", "none"), help="the speech model's int4 copy")
    ap.add_argument("--tokenizer", help="for GPTQ's calibration (default: tokenizer.json beside the weights)")
    a = ap.parse_args(argv)
    sd = read_safetensors(a.weights)
    cfg = ModelConfig.from_weights(sd)
    f32 = {x for x in a.f32.split(",") if x}
    voices = load_voices(Path(a.voices))
    calib = None
    if a.int4 == "gptq":
        tok = Path(a.tokenizer) if a.tokenizer else Path(a.weights).with_name("tokenizer.json")
        calib = gptq.calibrate(sd, cfg, voices["rafael"] if "rafael" in voices else next(iter(voices.values())), tok)
    p = pack(sd, voices, cfg, f32, rotated=not a.no_rotate, int4=a.int4 != "none", calib=calib)
    p.write(Path(a.out))
    print(f"{a.out}: {len(p.tensors)} tensors, {Path(a.out).stat().st_size / 1e6:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()

"""Pocket TTS in plain numpy, float32, written from kyutai-labs/pocket-tts (MIT).

The oracle the C++ engine is tested against: it reads the original weight names, so it checks
the packer too. Slow and simple on purpose; nothing here is optimized. The packer also runs it to
calibrate GPTQ (tts/gptq.py).
"""

from __future__ import annotations

import numpy as np

from .config import ModelConfig

F32 = np.float32


def layer_norm(x, w, b, eps):
    m = x.mean(-1, keepdims=True)
    v = ((x - m) ** 2).mean(-1, keepdims=True)
    y = (x - m) / np.sqrt(v + F32(eps))
    if w is not None:
        y = y * w + b
    return y.astype(F32)


def gelu_tanh(x):
    return (0.5 * x * (1 + np.tanh(F32(np.sqrt(2 / np.pi)) * (x + F32(0.044715) * x**3)))).astype(F32)


def silu(x):
    return (x / (1 + np.exp(-x))).astype(F32)


def elu(x):
    return np.where(x > 0, x, np.expm1(np.minimum(x, 0))).astype(F32)


def rope(x, pos, max_period):
    """x [T, H, D] rotated in adjacent pairs at absolute positions pos [T]."""
    d = x.shape[-1]
    freqs = np.exp(np.arange(d // 2, dtype=F32) * F32(-np.log(max_period) * 2 / d)).astype(F32)
    ang = pos.astype(F32)[:, None, None] * freqs
    c, s = np.cos(ang), np.sin(ang)
    xr, xi = x[..., 0::2], x[..., 1::2]
    out = np.empty_like(x)
    out[..., 0::2] = xr * c - xi * s
    out[..., 1::2] = xr * s + xi * c
    return out


def attend(q, k, v, pos_q, pos_k, context=None):
    """q [Tq, H, D], k/v [Tk, H, D] -> [Tq, H*D], causal (and windowed when context is set)."""
    delta = pos_q[:, None] - pos_k[None, :]
    mask = delta >= 0
    if context is not None:
        mask &= delta < context
    s = np.einsum("qhd,khd->hqk", q, k) / F32(np.sqrt(q.shape[-1]))
    s = np.where(mask[None], s, -np.inf)
    s = s - s.max(-1, keepdims=True)
    p = np.exp(s)
    p /= p.sum(-1, keepdims=True)
    o = np.einsum("hqk,khd->qhd", p.astype(F32), v)
    return o.reshape(o.shape[0], -1).astype(F32)


class Transformer:
    def __init__(self, sd, prefix, layers, heads, max_period, context=None, scaled=False):
        self.w = [{k[len(f"{prefix}{i}.") :]: v for k, v in sd.items() if k.startswith(f"{prefix}{i}.")} for i in range(layers)]
        self.heads, self.max_period, self.context, self.scaled = heads, max_period, context, scaled
        self.taps: dict[int, list] | None = None  # when set: the inputs of layer i's matrices at 4 i + 0..3

    def __call__(self, x, cache, offset):
        """x [T, D] at positions offset.. ; cache: per layer (k, v) [Tc, H, Dh] covering 0..offset."""
        t = x.shape[0]
        pos = np.arange(offset, offset + t)
        out_cache = []
        tap = (lambda i, j, a: self.taps.setdefault(4 * i + j, []).append(a)) if self.taps is not None else None
        for i, (w, (ck, cv)) in enumerate(zip(self.w, cache)):
            h = layer_norm(x, w["norm1.weight"], w["norm1.bias"], 1e-5)
            if tap:
                tap(i, 0, h)
            qkv = (h @ w["self_attn.in_proj.weight"].T).reshape(t, 3, self.heads, -1)
            q = rope(qkv[:, 0], pos, self.max_period)
            k = rope(qkv[:, 1], pos, self.max_period)
            v = qkv[:, 2]
            if cv is not None:
                k = np.concatenate([ck, k])
                v = np.concatenate([cv, v])
            out_cache.append((k, v))
            a = attend(q, k, v, pos, np.arange(k.shape[0]), self.context)
            if tap:
                tap(i, 1, a)
            a = a @ w["self_attn.out_proj.weight"].T
            if self.scaled:
                a = a * w["layer_scale_1.scale"]
            x = x + a
            h = layer_norm(x, w["norm2.weight"], w["norm2.bias"], 1e-5)
            g = gelu_tanh(h @ w["linear1.weight"].T)
            if tap:
                tap(i, 2, h)
                tap(i, 3, g)
            f = g @ w["linear2.weight"].T
            if self.scaled:
                f = f * w["layer_scale_2.scale"]
            x = (x + f).astype(F32)
        return x, out_cache


def timestep_embedding(sd, i, t):
    p = f"flow_lm.flow_net.time_embed.{i}."
    args = F32(t) * sd[p + "freqs"]
    e = np.concatenate([np.cos(args), np.sin(args)]).astype(F32)
    h = silu(e @ sd[p + "mlp.0.weight"].T + sd[p + "mlp.0.bias"])
    h = h @ sd[p + "mlp.2.weight"].T + sd[p + "mlp.2.bias"]
    var = h.var(ddof=1) + F32(1e-5)  # torch's x.var(): unbiased
    return (h * (sd[p + "mlp.3.alpha"] / np.sqrt(var))).astype(F32)


def flow_net(sd, c, x, depth, s=0.0, t=1.0):
    """SimpleMLPAdaLN: c [Dm] conditioning, x [ldim] noise -> flow direction [ldim]."""
    p = "flow_lm.flow_net."
    lin = lambda n, v: v @ sd[p + n + ".weight"].T + sd[p + n + ".bias"]
    x = lin("input_proj", x)
    y = lin("cond_embed", c) + (timestep_embedding(sd, 0, s) + timestep_embedding(sd, 1, t)) / F32(2)
    sy = silu(y)
    for i in range(depth):
        b = f"res_blocks.{i}."
        shift, scale, gate = np.split(lin(b + "adaLN_modulation.1", sy), 3)
        h = layer_norm(x, sd[p + b + "in_ln.weight"], sd[p + b + "in_ln.bias"], 1e-6)
        h = h * (1 + scale) + shift
        h = lin(b + "mlp.2", silu(lin(b + "mlp.0", h)))
        x = (x + gate * h).astype(F32)
    shift, scale = np.split(lin("final_layer.adaLN_modulation.1", sy), 2)
    h = layer_norm(x, None, None, 1e-6) * (1 + scale) + shift
    return lin("final_layer.linear", h).astype(F32)


class FlowLM:
    def __init__(self, sd, cfg: ModelConfig):
        self.sd, self.cfg = sd, cfg
        self.tr = Transformer(sd, "flow_lm.transformer.layers.", cfg.layers, cfg.heads, cfg.max_period)

    def voice_cache(self, voice):
        """A predefined voice (safetensors state) -> per-layer (k, v) [T, H, Dh]."""
        out = []
        for i in range(self.cfg.layers):
            c = voice[f"transformer.layers.{i}.self_attn/cache"]
            n = int(voice[f"transformer.layers.{i}.self_attn/offset"][0])
            out.append((c[0, 0, :n].astype(F32), c[1, 0, :n].astype(F32)))
        return out, n

    def prefill(self, voice, tokens):
        cache, n = self.voice_cache(voice)
        x = self.sd["flow_lm.conditioner.embed.weight"][np.asarray(tokens)]
        _, cache = self.tr(x, cache, n)
        return cache, n + len(tokens)

    def step(self, cache, offset, latent, noise):
        """latent: previous latent [ldim] or None for BOS; noise: x_0 [ldim] (already scaled)."""
        sd = self.sd
        if latent is None:
            latent = sd["flow_lm.bos_emb"]
        x = (latent @ sd["flow_lm.input_linear.weight"].T)[None]
        h, cache = self.tr(x, cache, offset)
        c = layer_norm(h[-1], sd["flow_lm.out_norm.weight"], sd["flow_lm.out_norm.bias"], 1e-5)
        eos = float(c @ sd["flow_lm.out_eos.weight"][0] + sd["flow_lm.out_eos.bias"][0])
        out = noise + flow_net(sd, c, noise, self.cfg.flow_depth)
        return out.astype(F32), eos, cache, offset + 1


def conv1d_causal(x, w, b):
    """x [T, Cin] time-major; w [Cout, Cin, k] (torch layout); zero history."""
    k = w.shape[2]
    xp = np.concatenate([np.zeros((k - 1, x.shape[1]), F32), x])
    y = sum(xp[j : j + x.shape[0]] @ w[:, :, j].T for j in range(k))
    return (y + (b if b is not None else 0)).astype(F32)


def convtr1d(x, w, b, stride):
    """ConvTranspose1d with kernel 2*stride, w [Cin, Cout, k]; trailing partial dropped."""
    t, _ = x.shape
    cout = w.shape[1]
    xprev = np.concatenate([np.zeros((1, x.shape[1]), F32), x[:-1]])
    y = np.empty((t, stride, cout), F32)
    for r in range(stride):
        y[:, r] = x @ w[:, :, r] + xprev @ w[:, :, r + stride]
    y = y.reshape(t * stride, cout)
    return (y + (b if b is not None else 0)).astype(F32)


class Mimi:
    def __init__(self, sd, cfg: ModelConfig):
        self.sd, self.cfg = sd, cfg
        self.tr = Transformer(
            sd, "mimi.decoder_transformer.transformer.layers.", cfg.m_layers, cfg.m_heads,
            cfg.m_max_period, context=cfg.m_context, scaled=True,
        )

    def decode(self, latents):
        """latents [T, ldim] in the flow LM's normalized space -> audio [T * frame_samples]."""
        sd, cfg = self.sd, self.cfg
        z = latents * sd["flow_lm.emb_std"] + sd["flow_lm.emb_mean"]
        x = z @ sd["mimi.quantizer.output_proj.weight"][:, :, 0].T
        # depthwise transposed conv, kernel 2*s
        w = sd["mimi.upsample.convtr.convtr.weight"][:, 0, :]  # [C, 2s]
        s = cfg.upsample
        xprev = np.concatenate([np.zeros((1, x.shape[1]), F32), x[:-1]])
        up = x[:, None, :] * w.T[None, :s, :] + xprev[:, None, :] * w.T[None, s:, :]
        x = up.reshape(-1, x.shape[1]).astype(F32)
        x, _ = self.tr(x, [(None, None)] * cfg.m_layers, 0)
        d = "mimi.decoder.model."
        x = conv1d_causal(x, sd[d + "0.conv.weight"], sd[d + "0.conv.bias"])
        idx = 1
        for ratio in cfg.ratios:
            x = convtr1d(elu(x), sd[f"{d}{idx + 1}.convtr.weight"], sd[f"{d}{idx + 1}.convtr.bias"], ratio)
            for j in range(cfg.n_residual):
                r = f"{d}{idx + 2 + j}.block."
                h = conv1d_causal(elu(x), sd[r + "1.conv.weight"], sd[r + "1.conv.bias"])
                h = conv1d_causal(elu(h), sd[r + "3.conv.weight"], sd[r + "3.conv.bias"])
                x = x + h
            idx += 2 + cfg.n_residual
        x = conv1d_causal(elu(x), sd[f"{d}{idx + 1}.conv.weight"], sd[f"{d}{idx + 1}.conv.bias"])
        return x[:, 0]


def max_frames(n_tokens: int, frame_rate: float = 12.5) -> int:
    return int(np.ceil((n_tokens / 3.0 + 2.0) * frame_rate))


def generate(lm: FlowLM, voice, tokens, noises, frames_after_eos, eos_threshold=-4.0, min_frames=6):
    """The reference's loop: stops frames_after_eos steps after the first EOS past min_frames."""
    cache, off = lm.prefill(voice, tokens)
    latent, out, eos_step = None, [], None
    for i in range(max_frames(len(tokens))):
        latent, eos, cache, off = lm.step(cache, off, latent, noises[i])
        if eos > eos_threshold and eos_step is None and i >= min_frames:
            eos_step = i
        if eos_step is not None and i >= eos_step + frames_after_eos:
            break
        out.append(latent)
    return np.stack(out)

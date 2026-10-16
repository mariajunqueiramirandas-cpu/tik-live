"""A random Pocket TTS small enough to test against the numpy reference in seconds: the original
weight names, real decoder convolutions, a 2-layer speech model and decoder transformer."""

from __future__ import annotations

import numpy as np

from tts.config import ModelConfig

F32 = np.float32
D, HEADS, LAYERS, FF, LDIM, VOCAB, FLOW, FLOW_DEPTH = 128, 2, 2, 256, 32, 40, 64, 2
M, M_HEADS, M_LAYERS, M_FF, M_CONTEXT = 128, 2, 2, 256, 40  # a short window: many history shifts
VOICE_LEN = 12


def model(seed: int = 0, eos_bias: float = -100.0) -> tuple[dict, dict, ModelConfig]:
    """-> (state dict, {voice name: voice state}, config). eos_bias -100: never ends early."""
    rng = np.random.default_rng(seed)

    def w(*shape, fan_in=None):
        return (rng.standard_normal(shape) / np.sqrt(fan_in or shape[-1])).astype(F32)

    def small(*shape):
        return (0.1 * rng.standard_normal(shape)).astype(F32)

    def norm(p, n):
        sd[p + "weight"], sd[p + "bias"] = (1 + small(n)).astype(F32), small(n)

    sd = {
        "flow_lm.conditioner.embed.weight": rng.standard_normal((VOCAB, D)).astype(F32),
        "flow_lm.bos_emb": rng.standard_normal(LDIM).astype(F32),
        "flow_lm.input_linear.weight": w(D, LDIM),
        "flow_lm.out_eos.weight": w(1, D),
        "flow_lm.out_eos.bias": np.array([eos_bias], F32),
        "flow_lm.emb_mean": small(LDIM),
        "flow_lm.emb_std": (1 + np.abs(small(LDIM))).astype(F32),
        "mimi.quantizer.output_proj.weight": w(M, LDIM)[:, :, None],
        "mimi.upsample.convtr.convtr.weight": (0.25 * rng.standard_normal((M, 1, 32))).astype(F32),
    }
    norm("flow_lm.out_norm.", D)
    for i in range(LAYERS):
        p = f"flow_lm.transformer.layers.{i}."
        sd[p + "self_attn.in_proj.weight"] = w(3 * D, D)
        sd[p + "self_attn.out_proj.weight"] = w(D, D)
        sd[p + "linear1.weight"] = w(FF, D)
        sd[p + "linear2.weight"] = w(D, FF)
        norm(p + "norm1.", D)
        norm(p + "norm2.", D)
    fl = "flow_lm.flow_net."
    sd[fl + "cond_embed.weight"], sd[fl + "cond_embed.bias"] = w(FLOW, D), small(FLOW)
    sd[fl + "input_proj.weight"], sd[fl + "input_proj.bias"] = w(FLOW, LDIM), small(FLOW)
    for i in range(FLOW_DEPTH):
        b = f"{fl}res_blocks.{i}."
        sd[b + "adaLN_modulation.1.weight"], sd[b + "adaLN_modulation.1.bias"] = w(3 * FLOW, FLOW), small(3 * FLOW)
        sd[b + "mlp.0.weight"], sd[b + "mlp.0.bias"] = w(FLOW, FLOW), small(FLOW)
        sd[b + "mlp.2.weight"], sd[b + "mlp.2.bias"] = w(FLOW, FLOW), small(FLOW)
        norm(b + "in_ln.", FLOW)
    sd[fl + "final_layer.adaLN_modulation.1.weight"] = w(2 * FLOW, FLOW)
    sd[fl + "final_layer.adaLN_modulation.1.bias"] = small(2 * FLOW)
    sd[fl + "final_layer.linear.weight"], sd[fl + "final_layer.linear.bias"] = w(LDIM, FLOW), small(LDIM)
    for j in range(2):
        t = f"{fl}time_embed.{j}."
        sd[t + "freqs"] = np.exp(-np.log(10000.0) * np.arange(128) / 128).astype(F32)
        sd[t + "mlp.0.weight"], sd[t + "mlp.0.bias"] = w(FLOW, 256), small(FLOW)
        sd[t + "mlp.2.weight"], sd[t + "mlp.2.bias"] = w(FLOW, FLOW), small(FLOW)
        sd[t + "mlp.3.alpha"] = np.ones(FLOW, F32)
    for i in range(M_LAYERS):
        p = f"mimi.decoder_transformer.transformer.layers.{i}."
        sd[p + "self_attn.in_proj.weight"] = w(3 * M, M)
        sd[p + "self_attn.out_proj.weight"] = w(M, M)
        sd[p + "linear1.weight"] = w(M_FF, M)
        sd[p + "linear2.weight"] = w(M, M_FF)
        sd[p + "layer_scale_1.scale"] = (0.3 + small(M)).astype(F32)
        sd[p + "layer_scale_2.scale"] = (0.3 + small(M)).astype(F32)
        norm(p + "norm1.", M)
        norm(p + "norm2.", M)
    # SEANet decoder at the real model's widths: conv, (convtr, residual block) per ratio, conv
    d, ch, idx = "mimi.decoder.model.", 512, 1
    sd[d + "0.conv.weight"], sd[d + "0.conv.bias"] = w(ch, M, 7, fan_in=7 * M), small(ch)
    for r in (6, 5, 4):
        out, hid = ch // 2, ch // 4
        sd[f"{d}{idx + 1}.convtr.weight"], sd[f"{d}{idx + 1}.convtr.bias"] = w(ch, out, 2 * r, fan_in=2 * ch), small(out)
        b = f"{d}{idx + 2}.block."
        sd[b + "1.conv.weight"], sd[b + "1.conv.bias"] = w(hid, out, 3, fan_in=3 * out), small(hid)
        sd[b + "3.conv.weight"], sd[b + "3.conv.bias"] = w(out, hid, 1, fan_in=hid), small(out)
        ch, idx = out, idx + 3
    sd[f"{d}{idx + 1}.conv.weight"], sd[f"{d}{idx + 1}.conv.bias"] = w(1, ch, 3, fan_in=3 * ch), small(1)

    voices = {}
    for name in ("ana", "bia"):
        v = {}
        for i in range(LAYERS):
            v[f"transformer.layers.{i}.self_attn/cache"] = rng.standard_normal(
                (2, 1, VOICE_LEN + 4, HEADS, D // HEADS)
            ).astype(F32)
            v[f"transformer.layers.{i}.self_attn/offset"] = np.array([VOICE_LEN], np.int64)
        voices[name] = v
    return sd, voices, ModelConfig.from_weights(sd, heads=HEADS, m_heads=M_HEADS, m_context=M_CONTEXT)

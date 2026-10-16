"""Pocket TTS hyperparameters, read off the weights where the shapes carry them."""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass

import numpy as np

SAMPLE_RATE = 24000


@dataclass(frozen=True)
class ModelConfig:
    d_model: int
    heads: int
    layers: int
    ff: int
    ldim: int
    vocab: int  # rows of the text lookup table (tokenizer size + 1 padding row)
    flow_dim: int
    flow_depth: int
    m_dim: int
    m_heads: int
    m_layers: int
    m_ff: int
    m_context: int
    n_filters: int
    ratios: tuple[int, ...]
    n_residual: int
    kernel: int
    res_kernel: int
    last_kernel: int
    upsample: int
    max_period: float = 10000.0
    m_max_period: float = 10000.0
    sample_rate: int = SAMPLE_RATE

    @property
    def frame_samples(self) -> int:
        """Audio samples per latent frame (1920 = 80 ms at 24 kHz)."""
        return self.upsample * int(np.prod(self.ratios))

    @property
    def frame_rate(self) -> float:
        return self.sample_rate / self.frame_samples

    def dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_weights(
        cls, sd: dict[str, np.ndarray], heads: int = 16, m_heads: int = 8, m_context: int = 250
    ) -> "ModelConfig":
        def count(prefix: str) -> int:
            pat = re.compile(re.escape(prefix) + r"(\d+)\.")
            return 1 + max(int(m.group(1)) for k in sd for m in [pat.match(k)] if m)

        f = "flow_lm.transformer.layers.0."
        m = "mimi.decoder_transformer.transformer.layers.0."
        dec = sorted(
            int(k.split(".")[3]) for k in sd if k.startswith("mimi.decoder.model.") and k.endswith("convtr.weight")
        )
        ratios = tuple(sd[f"mimi.decoder.model.{i}.convtr.weight"].shape[2] // 2 for i in dec)
        last = max(int(k.split(".")[3]) for k in sd if k.startswith("mimi.decoder.model."))
        n_res = sum(
            1 for k in sd if re.match(rf"mimi\.decoder\.model\.\d+\.block\.1\.conv\.weight$", k)
        ) // len(ratios)
        return cls(
            d_model=sd[f + "self_attn.in_proj.weight"].shape[1],
            heads=heads,
            layers=count("flow_lm.transformer.layers."),
            ff=sd[f + "linear1.weight"].shape[0],
            ldim=sd["flow_lm.input_linear.weight"].shape[1],
            vocab=sd["flow_lm.conditioner.embed.weight"].shape[0],
            flow_dim=sd["flow_lm.flow_net.cond_embed.weight"].shape[0],
            flow_depth=count("flow_lm.flow_net.res_blocks."),
            m_dim=sd[m + "self_attn.in_proj.weight"].shape[1],
            m_heads=m_heads,
            m_layers=count("mimi.decoder_transformer.transformer.layers."),
            m_ff=sd[m + "linear1.weight"].shape[0],
            m_context=m_context,
            n_filters=sd[f"mimi.decoder.model.{last}.conv.weight"].shape[1],
            ratios=ratios,
            n_residual=n_res,
            kernel=sd["mimi.decoder.model.0.conv.weight"].shape[2],
            res_kernel=sd[f"mimi.decoder.model.{dec[0] + 1}.block.1.conv.weight"].shape[2],
            last_kernel=sd[f"mimi.decoder.model.{last}.conv.weight"].shape[2],
            upsample=sd["mimi.upsample.convtr.convtr.weight"].shape[2] // 2,
        )

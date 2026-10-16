"""GPTQ (Frantar et al., 2022) for the speech model's int4 matrices, on their rotated inputs.

Calibration runs the float32 numpy model (tts/reference.py) on CALIBRATION, store replies that
bench_replies.txt doesn't use, and keeps every transformer matrix's input. Each matrix is then
quantized one input column at a time, in decreasing order of the input's energy, and each
column's rounding error is pushed onto the columns not yet quantized, weighted by the inputs'
covariance, so the matrix's outputs on those inputs move as little as int4 allows. Round to
nearest leaves the speech model's hidden states 35% off float32; GPTQ, 12%.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import reference
from .config import ModelConfig
from .text import Chunker, normalize

CALIBRATION = [
    "Boa tarde! Seja bem-vindo à nossa loja, posso te ajudar a escolher?",
    "O hambúrguer artesanal vem com batata frita e custa R$ 36,90.",
    "Sim, fazemos entrega no seu bairro, a taxa é de R$ 6,00.",
    "Infelizmente esse tamanho acabou, mas chega reposição na sexta-feira.",
    "Você pode pagar com cartão, Pix ou dinheiro na entrega.",
    "Seu pedido foi recebido e já está sendo preparado.",
    "A blusa de linho está com 20% de desconto até domingo.",
    "Temos as cores branca, preta e azul-marinho, qual você prefere?",
    "O motoboy já saiu e deve chegar em uns quinze minutos.",
    "Para trocar, é só trazer o produto com a nota fiscal em até 30 dias.",
    "A torta de limão serve oito pessoas e precisa de um dia de antecedência.",
    "Me manda o seu endereço completo que eu calculo o frete.",
    "O horário de funcionamento é das 8h às 20h, de segunda a sábado.",
    "Desculpe a demora! Estamos com muitos pedidos hoje, mas o seu já vai sair.",
    "Esse modelo tem garantia de seis meses contra defeitos de fabricação.",
    "Quer aproveitar e levar o segundo item com metade do preço?",
    "Anotei aqui: duas coxinhas, um pastel de queijo e um suco de laranja.",
    "O tênis é bem confortável e a forma é normal, pode pedir o seu número de sempre.",
    "Chegou o comprovante, obrigado! Já confirmei o pagamento.",
    "Amanhã a loja abre mais tarde, às 10h, por causa do inventário.",
    "A consulta de avaliação é gratuita e dura cerca de quarenta minutos.",
    "Pode deixar que eu te aviso assim que o produto voltar ao estoque.",
    "O kit presente vem embalado com laço e cartão, sem custo adicional.",
    "Qual é o melhor horário para a entrega, de manhã ou à tarde?",
    "Nossa pizza grande tem oito fatias e a média tem seis.",
    "Vou te mandar as fotos do produto aqui mesmo na conversa.",
    "O valor total ficou em R$ 128,40, já com o desconto do cupom.",
    "A gente aceita encomendas para festas com até uma semana de antecedência.",
    "Esse perfume tem notas de baunilha e madeira, é o mais vendido da loja.",
    "Se o produto chegar com qualquer problema, é só me chamar que a gente resolve.",
    "Obrigada pela preferência e volte sempre!",
    "O estacionamento é gratuito para clientes por até duas horas.",
]


def calibrate(sd: dict[str, np.ndarray], cfg: ModelConfig, voice: dict[str, np.ndarray], tokenizer_path: Path,
              steps: int = 30) -> dict[int, np.ndarray]:
    """Inputs of the transformer's matrices on CALIBRATION, keyed 4 * layer + (qkv, o, ff1, ff2)."""
    from tokenizers import Tokenizer

    tk = Tokenizer.from_file(str(tokenizer_path))
    chunker = Chunker(lambda s: tk.encode(s).ids, tk.decode)
    lm = reference.FlowLM(sd, cfg)
    lm.tr.taps = {}
    rng = np.random.default_rng(0)
    for text in CALIBRATION:
        for chunk in chunker.split(normalize(text)):
            cache, off = lm.prefill(voice, chunk.tokens)
            latent = None
            for _ in range(steps):
                noise = (rng.standard_normal(cfg.ldim) * np.sqrt(0.3)).astype(np.float32)
                latent, eos, cache, off = lm.step(cache, off, latent, noise)
                if eos > -4.0:
                    break
    return {k: np.concatenate(v).astype(np.float32) for k, v in lm.tr.taps.items()}


def row_scales(w: np.ndarray) -> np.ndarray:
    """Symmetric int4 (-8..7), one scale per row: the clipping that minimizes each row's rounding error."""
    best_err = best_s = None
    for r in (1.0, 0.95, 0.9, 0.85, 0.8, 0.75):
        s = np.abs(w).max(axis=1) * r / 7.0
        s = np.where(s > 0, s, 1.0)
        err = ((np.clip(np.rint(w / s[:, None]), -8, 7) * s[:, None] - w) ** 2).sum(axis=1)
        if best_err is None:
            best_err, best_s = err, s
        else:
            best_s = np.where(err < best_err, s, best_s)
            best_err = np.minimum(err, best_err)
    return best_s


def round_to_nearest(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """w [N, K] -> int4 codes and one scale per row, without calibration."""
    s = row_scales(w)
    return np.clip(np.rint(w / s[:, None]), -8, 7).astype(np.int8), s.astype(np.float32)


def quantize(w: np.ndarray, x: np.ndarray, damp: float = 0.01, block: int = 128) -> tuple[np.ndarray, np.ndarray]:
    """w [N, K] and its inputs x [rows, K] -> int4 codes (-8..7) [N, K] and one scale per row."""
    w = w.astype(np.float64).copy()
    k = w.shape[1]
    h = x.astype(np.float64).T @ x.astype(np.float64)
    dead = np.diag(h) == 0
    h[dead, dead] = 1
    w[:, dead] = 0
    best_s = row_scales(w)
    s = best_s[:, None]
    order = np.argsort(-np.diag(h))
    w, h = w[:, order], h[order][:, order]
    h += damp * np.mean(np.diag(h)) * np.eye(k)
    hinv = np.linalg.cholesky(np.linalg.inv(h)).T  # upper Cholesky factor of H^-1
    q = np.zeros_like(w)
    for i1 in range(0, k, block):
        i2 = min(i1 + block, k)
        w1, hb = w[:, i1:i2].copy(), hinv[i1:i2, i1:i2]
        err = np.zeros_like(w1)
        for i in range(i2 - i1):
            qi = np.clip(np.rint(w1[:, i : i + 1] / s), -8, 7)
            q[:, i1 + i : i1 + i + 1] = qi
            e = (w1[:, i : i + 1] - qi * s) / hb[i, i]
            w1[:, i:] -= e @ hb[i : i + 1, i:]
            err[:, i : i + 1] = e
        w[:, i2:] -= err @ hinv[i1:i2, i2:]
    return q[:, np.argsort(order)].astype(np.int8), best_s.astype(np.float32)

"""Text -> what the model reads well: Brazilian Portuguese with prices, numbers, times and dates
in words, cut into chunks of about one sentence (a port of pocket-tts's text_chunking).

The Portuguese tokenizer has no digits or symbols: "R$ 49,90" is nine byte-fallback tokens the
model rarely saw in training. So prices, percentages, times, dates, quantities and other numbers
become words here, and what has no spoken form (emoji, WhatsApp's *bold* markers, links) goes.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

_UNITS = (
    "zero um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze "
    "dezesseis dezessete dezoito dezenove"
).split()
_TENS = ("", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa")
_HUNDREDS = (
    "", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos",
    "oitocentos", "novecentos",
)
_SCALES = (("milhão", "milhões"), ("bilhão", "bilhões"), ("trilhão", "trilhões"))
_ORD_UNITS = ("", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono")
_ORD_TENS = (
    "", "décimo", "vigésimo", "trigésimo", "quadragésimo", "quinquagésimo", "sexagésimo", "septuagésimo",
    "octogésimo", "nonagésimo",
)
_MONTHS = (
    "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro"
).split()
_UNIT_WORDS = {
    "kg": ("quilo", "quilos"),
    "g": ("grama", "gramas"),
    "mg": ("miligrama", "miligramas"),
    "ml": ("mililitro", "mililitros"),
    "mL": ("mililitro", "mililitros"),
    "l": ("litro", "litros"),
    "L": ("litro", "litros"),
    "km": ("quilômetro", "quilômetros"),
    "m": ("metro", "metros"),
    "cm": ("centímetro", "centímetros"),
    "mm": ("milímetro", "milímetros"),
}
_ABBREVIATIONS = {"Sr": "senhor", "Sra": "senhora", "Dr": "doutor", "Dra": "doutora", "Av": "avenida"}
_SHORTHAND = {"c": "com", "s": "sem", "p": "para"}  # "c/ frete", "s/ juros", "p/ você"
_SYMBOLS = {"&": " e ", "+": " mais ", "=": " igual a ", "@": " arroba "}
MAX_DIGITS = 15  # longer runs are read digit by digit


def _unit(n: int, fem: bool) -> str:
    return ("uma", "duas")[n - 1] if fem and n in (1, 2) else _UNITS[n]


def _below_1000(n: int, fem: bool) -> str:
    if n == 100:
        return "cem"
    h, r = divmod(n, 100)
    words = []
    if h:
        words.append(_HUNDREDS[h][:-2] + "as" if fem and h > 1 else _HUNDREDS[h])
    if r:
        t, u = divmod(r, 10)
        words.append(_unit(r, fem) if r < 20 else _TENS[t] + (" e " + _unit(u, fem) if u else ""))
    return " e ".join(words)


def cardinal(n: int, fem: bool = False) -> str:
    """0 <= n < 10**15 in words; fem agrees with a feminine noun (duas horas, duzentas vezes)."""
    if n == 0:
        return "zero"
    groups = []  # (power of 1000, value), highest first
    i = 0
    while n:
        n, g = divmod(n, 1000)
        if g:
            groups.append((i, g))
        i += 1
    groups.reverse()
    out = []
    for k, (i, g) in enumerate(groups):
        if i == 0:
            w = _below_1000(g, fem)
        elif i == 1:
            w = "mil" if g == 1 else _below_1000(g, fem) + " mil"
        else:
            w = _below_1000(g, False) + " " + _SCALES[i - 2][g > 1]
        # "mil e duzentos", "mil duzentos e trinta": "e" before a last group under 100 or round
        if k and k == len(groups) - 1 and (g < 100 or g % 100 == 0):
            out.append("e")
        out.append(w)
    return " ".join(out)


def ordinal(n: int, fem: bool = False) -> str:
    if not 1 <= n <= 99:
        return cardinal(n, fem)
    t, u = divmod(n, 10)
    words = [w for w in (_ORD_TENS[t], _ORD_UNITS[u]) if w]
    return " ".join(w[:-1] + "a" for w in words) if fem else " ".join(words)


def digits(s: str) -> str:
    return " ".join(_UNITS[int(c)] for c in s if c.isdigit())


def _int(s: str) -> int:
    return int(s.replace(".", ""))


def _number(whole: str, frac: str | None = None, fem: bool = False) -> str:
    n = _int(whole)
    if len(str(n)) > MAX_DIGITS:
        words = digits(whole)
    else:
        words = cardinal(n, fem)
    if frac:
        zeros = len(frac) - len(frac.lstrip("0"))
        rest = frac[zeros:]
        tail = ["zero"] * zeros + ([cardinal(int(rest))] if rest and len(rest) <= 3 else [digits(rest)] if rest else [])
        words += " vírgula " + " ".join(tail)
    return words


def money(reais: int, cents: int) -> str:
    parts = []
    if reais:
        de = " de" if reais >= 10**6 and reais % 10**6 == 0 else ""  # "um milhão de reais"
        parts.append(f"{cardinal(reais)}{de} {'real' if reais == 1 else 'reais'}")
    if cents:
        parts.append(f"{cardinal(cents)} {'centavo' if cents == 1 else 'centavos'}")
    return " e ".join(parts) or "zero reais"


def _hours(h: int, m: int = 0) -> str:
    if m:
        return f"{cardinal(h, fem=True)} e {cardinal(m)}"
    return f"{cardinal(h, fem=True)} {'hora' if h == 1 else 'horas'}"


def _date(d: int, m: int, y: str | None) -> str | None:
    if not (1 <= d <= 31 and 1 <= m <= 12):
        return None
    out = f"{'primeiro' if d == 1 else cardinal(d)} de {_MONTHS[m - 1]}"
    if y:
        out += " de " + cardinal(int(y) + (2000 if len(y) == 2 else 0))
    return out


_NUM = r"\d{1,3}(?:\.\d{3})+(?!\d)|\d+"  # 1.234.567 or 1234567
_RULES: list[tuple[re.Pattern, Callable[[re.Match], str]]] = [
    (re.compile(r"https?://\S+|www\.\S+"), lambda m: " "),
    # phone numbers, CEPs: digit by digit, in their groups
    (
        re.compile(r"(?:\+55\s?)?\(?\b\d{2}\)?\s?\d{4,5}[-\s]?\d{4}\b|\b\d{5}-\d{3}\b"),
        lambda m: ", ".join(digits(g) for g in re.findall(r"\d+", m.group())),
    ),
    (
        re.compile(rf"R\$\s?({_NUM})(?:,(\d{{1,2}}))?"),
        lambda m: money(_int(m[1]), int((m[2] or "0").ljust(2, "0"))),
    ),
    (re.compile(rf"({_NUM})(?:,(\d+))?\s?%"), lambda m: _number(m[1], m[2]) + " por cento"),
    (re.compile(r"(-?\d+)\s?°C"), lambda m: ("menos " if m[1][0] == "-" else "") + cardinal(abs(int(m[1]))) + " graus"),
    (re.compile(r"\b([01]?\d|2[0-3])[h:]([0-5]\d)\b"), lambda m: _hours(int(m[1]), int(m[2]))),
    (re.compile(r"\b(\d{1,2})\s?h\b"), lambda m: _hours(int(m[1]))),
    (re.compile(r"\b(\d{1,3})\s?min\b"), lambda m: f"{cardinal(int(m[1]))} {'minuto' if m[1] == '1' else 'minutos'}"),
    (
        re.compile(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?\b"),
        lambda m: _date(int(m[1]), int(m[2]), m[3]) or m.group().replace("/", " barra "),
    ),
    # installments: "10x sem juros"
    (re.compile(r"\b(\d{1,2})\s?[xX]\b"), lambda m: f"{cardinal(int(m[1]), fem=True)} {'vez' if m[1] == '1' else 'vezes'}"),
    (re.compile(r"\b[nN][º°o]\.?\s?(?=\d)"), lambda m: "número "),
    (re.compile(r"\b(\d{1,2})\s?([ºª°])"), lambda m: ordinal(int(m[1]), fem=m[2] == "ª")),
    (
        re.compile(rf"({_NUM})(?:,(\d+))?\s?({'|'.join(_UNIT_WORDS)})\b"),
        lambda m: f"{_number(m[1], m[2])} {_UNIT_WORDS[m[3]][0 if m[1] == '1' and not m[2] else 1]}",
    ),
    (re.compile(rf"({_NUM}),(\d+)"), lambda m: _number(m[1], m[2])),
    (re.compile(rf"\d{{{MAX_DIGITS + 1},}}"), lambda m: digits(m.group())),
    (re.compile(_NUM), lambda m: _number(m.group())),
    (re.compile(r"\b(Sra|Sr|Dra|Dr|Av)\.(?=\s)"), lambda m: _ABBREVIATIONS[m[1]]),
    (re.compile(r"(?<!\w)([csp])/(?=\s|\w)", re.I), lambda m: _SHORTHAND[m[1].lower()] + " "),
]
_KEEP_PUNCT = set(".,!?;:'-—")


def normalize(text: str) -> str:
    """Raw text (a seller's reply) -> words and punctuation only."""
    text = unicodedata.normalize("NFC", text)
    for pattern, spoken in _RULES:
        text = pattern.sub(spoken, text)
    out = []
    for c in text:
        if c in _SYMBOLS:
            out.append(_SYMBOLS[c])
        elif c.isalpha() or c in _KEEP_PUNCT or unicodedata.category(c)[0] == "M":
            out.append(c)
        elif c.isdigit():  # one a rule left: a lone superscript, say
            out.append(" " + digits(c) + " " if c in "0123456789" else " ")
        elif c == "–":
            out.append(", ")
        elif c == "…":  # not in the vocabulary; three periods are
            out.append("...")
        else:  # spaces, emoji, symbols, WhatsApp's *_~ markers, brackets and quotes
            out.append(" ")
    text = " ".join("".join(out).split())
    return re.sub(r"\s+([.,!?;:])", r"\1", text)


# --- chunking: pocket-tts's text_chunking with the Portuguese config ---

_REPLACE = str.maketrans({'"': "", "“": "", "”": "", "„": "", "«": "", "»": "", "’": "'", "‘": "'",
                          "(": "", ")": "", "[": "", "]": ""})
_TERMINAL = ".!?…"
_WEAK = ",;:-–—"
_CLOSERS = "\"'”’)]»"


def prepare(text: str) -> tuple[str, int]:
    """One chunk -> the prompt the model reads, and the frames to keep after its end-of-speech."""
    text = " ".join(text.strip().translate(_REPLACE).split())
    text = re.sub(r"([.!?…])\s*[,;:]", r"\1", text)
    if not text:
        raise ValueError("empty text")
    frames_after_eos = 3 if len(text.split()) <= 4 else 1
    if not text[0].isupper():
        text = text[0].upper() + text[1:]
    # the model mispronounces or repeats a last word without a sentence end
    core = text.rstrip(_CLOSERS + " ")
    if core and core[-1] in _WEAK:
        text = core.rstrip(_WEAK + " ") + "." + text[len(core) :].strip()
    elif core and core[-1] not in _TERMINAL:
        text += "."
    return text, frames_after_eos


@dataclass(frozen=True)
class Chunk:
    text: str
    tokens: list[int]
    frames_after_eos: int


class Chunker:
    """Splits at sentence ends, then at commas within sentences over max_tokens, and packs the
    pieces into chunks of up to max_tokens. A chunk the model can't take whole (over hard_max)
    is cut between words."""

    def __init__(self, encode: Callable[[str], list[int]], decode: Callable[[list[int]], str],
                 max_tokens: int = 50, hard_max: int = 100):
        self.encode, self.decode = encode, decode
        self.max_tokens, self.hard_max = max_tokens, hard_max
        _, *ends = encode(".!...?")  # the first token is the word-start marker
        _, *weak = encode(",;:")
        self._ends, self._weak = set(ends), set(weak)

    def _segments(self, tokens: list[int], marks: set[int]) -> list[tuple[int, str]]:
        cuts, after_mark = [0], False
        for i, t in enumerate(tokens):
            if t in marks:
                after_mark = True
            elif after_mark:
                cuts.append(i)
                after_mark = False
        cuts.append(len(tokens))
        return [(b - a, self.decode(tokens[a:b])) for a, b in zip(cuts, cuts[1:]) if b > a]

    def split(self, text: str) -> list[Chunk]:
        text, _ = prepare(text)
        pieces = []
        for n, sentence in self._segments(self.encode(text), self._ends):
            subs = self._segments(self.encode(sentence.strip()), self._weak) if n > self.max_tokens else []
            pieces += subs if len(subs) > 1 else [(n, sentence)]
        merged: list[tuple[int, str]] = []
        for n, piece in pieces:
            if merged and merged[-1][0] + n <= self.max_tokens:
                merged[-1] = (merged[-1][0] + n, merged[-1][1] + " " + piece)
            else:
                merged.append((n, piece))
        out = []
        for _, piece in merged:
            for part in self._fit(piece.strip()):
                prompt, fae = prepare(part)
                out.append(Chunk(prompt, self.encode(prompt), fae + 2))
        return out

    def _fit(self, text: str) -> list[str]:
        if len(self.encode(prepare(text)[0])) <= self.hard_max:
            return [text]
        parts, cur = [], []
        for word in text.split():
            if cur and len(self.encode(prepare(" ".join(cur + [word]))[0])) > self.hard_max:
                parts.append(" ".join(cur))
                cur = []
            cur.append(word)  # a single word over hard_max is beyond saving; the engine rejects it
        return parts + [" ".join(cur)]

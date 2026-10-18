/**
 * Text -> what a Brazilian Portuguese voice reads well: prices, numbers,
 * times and dates in words, and nothing without a spoken form (emoji, links,
 * brackets). A port of the self-hosted voice's normalizer
 * (services/tts/tts/text.py) for the Fish Audio voice (ADR-0030), plus what a
 * live host needs: numbers agree with the noun after them ("mil duzentas e
 * cinquenta curtidas"), "7x8" is "sete vezes oito", and "@" before a name is
 * silent. The caption on stage keeps the line as written.
 *
 * Square and angle brackets never survive: Drama 3 would act a bracketed word
 * from a viewer's nickname as a stage direction.
 */

const UNITS = "zero um dois três quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete dezoito dezenove".split(" ");
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const SCALES: Array<[string, string]> = [
  ["milhão", "milhões"],
  ["bilhão", "bilhões"],
  ["trilhão", "trilhões"],
];
const ORD_UNITS = ["", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono"];
const ORD_TENS = ["", "décimo", "vigésimo", "trigésimo", "quadragésimo", "quinquagésimo", "sexagésimo", "septuagésimo", "octogésimo", "nonagésimo"];
const MONTHS = "janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro".split(" ");
const UNIT_WORDS: Record<string, [string, string]> = {
  kg: ["quilo", "quilos"],
  g: ["grama", "gramas"],
  mg: ["miligrama", "miligramas"],
  ml: ["mililitro", "mililitros"],
  mL: ["mililitro", "mililitros"],
  l: ["litro", "litros"],
  L: ["litro", "litros"],
  km: ["quilômetro", "quilômetros"],
  m: ["metro", "metros"],
  cm: ["centímetro", "centímetros"],
  mm: ["milímetro", "milímetros"],
};
const ABBREVIATIONS: Record<string, string> = { Sr: "senhor", Sra: "senhora", Dr: "doutor", Dra: "doutora", Av: "avenida" };
const SHORTHAND: Record<string, string> = { c: "com", s: "sem", p: "para" };
const SYMBOLS: Record<string, string> = { "&": " e ", "+": " mais ", "=": " igual a " };
const KEEP_PUNCT = new Set([".", ",", "!", "?", ";", ":", "'", "-", "—"]);
/** Longer runs of digits are read digit by digit. */
const MAX_DIGITS = 15;

function unit(n: number, fem: boolean): string {
  if (fem && n === 1) return "uma";
  if (fem && n === 2) return "duas";
  return UNITS[n] as string;
}

function below1000(n: number, fem: boolean): string {
  if (n === 100) return "cem";
  const h = Math.floor(n / 100);
  const r = n % 100;
  const words: string[] = [];
  if (h) words.push(fem && h > 1 ? `${(HUNDREDS[h] as string).slice(0, -2)}as` : (HUNDREDS[h] as string));
  if (r) {
    const t = Math.floor(r / 10);
    const u = r % 10;
    words.push(r < 20 ? unit(r, fem) : `${TENS[t]}${u ? ` e ${unit(u, fem)}` : ""}`);
  }
  return words.join(" e ");
}

/** 0 <= n < 10^15 in words; `fem` agrees with a feminine noun (duas horas, duzentas curtidas). */
export function cardinal(n: number, fem = false): string {
  if (n === 0) return "zero";
  const groups: Array<[number, number]> = []; // [power of 1000, value], lowest first
  for (let i = 0, rest = n; rest > 0; i++, rest = Math.floor(rest / 1000)) {
    if (rest % 1000) groups.push([i, rest % 1000]);
  }
  groups.reverse();
  const out: string[] = [];
  groups.forEach(([i, g], k) => {
    const words = i === 0 ? below1000(g, fem) : i === 1 ? (g === 1 ? "mil" : `${below1000(g, fem)} mil`) : `${below1000(g, false)} ${(SCALES[i - 2] as [string, string])[g > 1 ? 1 : 0]}`;
    // "mil e duzentos", "mil duzentos e trinta": "e" before a last group under 100 or round
    if (k > 0 && k === groups.length - 1 && (g < 100 || g % 100 === 0)) out.push("e");
    out.push(words);
  });
  return out.join(" ");
}

export function ordinal(n: number, fem = false): string {
  if (n < 1 || n > 99) return cardinal(n, fem);
  const words = [ORD_TENS[Math.floor(n / 10)], ORD_UNITS[n % 10]].filter((w): w is string => Boolean(w));
  return (fem ? words.map((w) => `${w.slice(0, -1)}a`) : words).join(" ");
}

function digits(s: string): string {
  return [...s].filter((c) => c >= "0" && c <= "9").map((c) => UNITS[Number(c)]).join(" ");
}

const int = (s: string) => Number(s.replaceAll(".", ""));

function number(whole: string, frac?: string, fem = false): string {
  const n = int(whole);
  let words = String(n).length > MAX_DIGITS ? digits(whole) : cardinal(n, fem);
  if (frac) {
    const rest = frac.replace(/^0+/, "");
    const tail = [...Array<string>(frac.length - rest.length).fill("zero"), ...(rest ? [rest.length <= 3 ? cardinal(Number(rest)) : digits(rest)] : [])];
    words += ` vírgula ${tail.join(" ")}`;
  }
  return words;
}

function money(reais: number, cents: number): string {
  const parts: string[] = [];
  if (reais) parts.push(`${cardinal(reais)}${reais >= 1_000_000 && reais % 1_000_000 === 0 ? " de" : ""} ${reais === 1 ? "real" : "reais"}`);
  if (cents) parts.push(`${cardinal(cents)} ${cents === 1 ? "centavo" : "centavos"}`);
  return parts.join(" e ") || "zero reais";
}

function hours(h: number, m = 0): string {
  return m ? `${cardinal(h, true)} e ${cardinal(m)}` : `${cardinal(h, true)} ${h === 1 ? "hora" : "horas"}`;
}

function date(d: number, m: number, y: string | undefined): string | null {
  if (d < 1 || d > 31 || m < 1 || m > 12) return null;
  let out = `${d === 1 ? "primeiro" : cardinal(d)} de ${MONTHS[m - 1]}`;
  if (y) out += ` de ${cardinal(Number(y) + (y.length === 2 ? 2000 : 0))}`;
  return out;
}

/** Feminine nouns that don't end in -a, and masculine ones that do. */
const FEMININE = new Set(
  "vez vezes noite noites tarde tardes mulher mulheres mãe mães flor flores chance chances cor cores dor dores fase fases frase frases parte partes ponte pontes rede redes sorte sortes lei leis série séries classe classes base bases nuvem nuvens live lives".split(" "),
);
const MASCULINE = new Set(
  "dia dias mapa mapas problema problemas tema temas programa programas sistema sistemas planeta planetas idioma idiomas poema poemas clima climas cinema cinemas pijama pijamas telefonema telefonemas esquema esquemas diploma diplomas fantasma fantasmas cometa cometas drama dramas cara caras papa papas guarda guardas sofá sofás atleta atletas poeta poetas pirata piratas lema lemas dilema dilemas enigma enigmas aroma aromas trauma traumas".split(" "),
);

function isFeminine(word: string): boolean {
  if (MASCULINE.has(word)) return false;
  if (FEMININE.has(word)) return true;
  if (/istas?$/.test(word)) return false; // artista, turista: either gender; counted as masculine
  return /(?:as?|ãs?|ção|ções|são|sões|dade|dades|gem|gens|tude|tudes)$/.test(word);
}

/** Whether a number agrees in the feminine with what follows it: "2 curtidas", "2 mil curtidas". */
function followedByFeminine(after: string): boolean {
  const next = /^\s+(\p{L}+)(?:\s+(\p{L}+))?/u.exec(after);
  if (!next) return false;
  let word = (next[1] as string).toLowerCase();
  if (word === "mil") {
    if (!next[2]) return false;
    word = next[2].toLowerCase();
  }
  return isFeminine(word);
}

type Spoken = (m: RegExpExecArray) => string;

function sub(text: string, pattern: RegExp, spoken: Spoken): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    out += text.slice(last, m.index) + spoken(m);
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

const g = (m: RegExpExecArray, i: number) => m[i] as string;
const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?!\d)|\d+`; // 1.234.567 or 1234567

const RULES: Array<[RegExp, Spoken]> = [
  [/https?:\/\/\S+|www\.\S+/g, () => " "],
  // phone numbers, CEPs: digit by digit, in their groups
  [/(?:\+55\s?)?\(?\b\d{2}\)?\s?\d{4,5}[-\s]?\d{4}\b|\b\d{5}-\d{3}\b/g, (m) => [...m[0].matchAll(/\d+/g)].map((d) => digits(d[0])).join(", ")],
  [new RegExp(String.raw`R\$\s?(${NUM})(?:,(\d{1,2}))?`, "g"), (m) => money(int(g(m, 1)), Number((m[2] ?? "0").padEnd(2, "0")))],
  [new RegExp(String.raw`(${NUM})(?:,(\d+))?\s?%`, "g"), (m) => `${number(g(m, 1), m[2])} por cento`],
  [/(-?\d+)\s?°C/g, (m) => `${g(m, 1).startsWith("-") ? "menos " : ""}${cardinal(Math.abs(Number(g(m, 1))))} graus`],
  [/\b([01]?\d|2[0-3])[h:]([0-5]\d)\b/g, (m) => hours(Number(g(m, 1)), Number(g(m, 2)))],
  [/\b(\d{1,2})\s?h\b/g, (m) => hours(Number(g(m, 1)))],
  [/\b(\d{1,3})\s?min\b/g, (m) => `${cardinal(Number(g(m, 1)))} ${g(m, 1) === "1" ? "minuto" : "minutos"}`],
  [/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m) => date(Number(g(m, 1)), Number(g(m, 2)), m[3]) ?? m[0].replaceAll("/", " barra ")],
  // quiz maths: "7x8", "7 x 8", "7 × 8"
  [/\b(\d+)\s?[xX×]\s?(\d+)\b/g, (m) => `${number(g(m, 1))} vezes ${number(g(m, 2))}`],
  // installments: "10x sem juros"
  [/\b(\d{1,2})\s?[xX]\b/g, (m) => `${cardinal(Number(g(m, 1)), true)} ${g(m, 1) === "1" ? "vez" : "vezes"}`],
  [/\b[nN][º°o]\.?\s?(?=\d)/g, () => "número "],
  [/\b(\d{1,2})\s?([ºª°])/g, (m) => ordinal(Number(g(m, 1)), m[2] === "ª")],
  [
    new RegExp(String.raw`(${NUM})(?:,(\d+))?\s?(${Object.keys(UNIT_WORDS).join("|")})\b`, "g"),
    (m) => `${number(g(m, 1), m[2])} ${(UNIT_WORDS[g(m, 3)] as [string, string])[g(m, 1) === "1" && !m[2] ? 0 : 1]}`,
  ],
  [new RegExp(String.raw`(${NUM}),(\d+)`, "g"), (m) => number(g(m, 1), g(m, 2))],
  [new RegExp(String.raw`\d{${MAX_DIGITS + 1},}`, "g"), (m) => digits(m[0])],
  [new RegExp(NUM, "g"), (m) => number(m[0], undefined, followedByFeminine(m.input.slice(m.index + m[0].length)))],
  [/\b(Sra|Sr|Dra|Dr|Av)\.(?=\s)/g, (m) => ABBREVIATIONS[g(m, 1)] as string],
  [/(?<![\p{L}\p{N}_])([csp])\/(?=\s|[\p{L}\p{N}_])/giu, (m) => `${SHORTHAND[g(m, 1).toLowerCase()]} `],
  // "@ana, valeu!": a handle is said as a name
  [/@(?=[\p{L}\p{N}_])/gu, () => ""],
];

/** A line as the host wrote it -> words and punctuation only, ready for the voice. */
export function speakable(text: string): string {
  let out = text.normalize("NFC");
  for (const [pattern, spoken] of RULES) out = sub(out, pattern, spoken);
  const chars: string[] = [];
  for (const c of out) {
    if (c in SYMBOLS) chars.push(SYMBOLS[c] as string);
    else if (/[\p{L}\p{M}]/u.test(c) || KEEP_PUNCT.has(c)) chars.push(c);
    else if (c >= "0" && c <= "9") chars.push(` ${digits(c)} `);
    else if (c === "–") chars.push(", ");
    else if (c === "…") chars.push("...");
    else chars.push(" "); // spaces, emoji, symbols, *_~ markers, brackets and quotes
  }
  return chars.join("").split(/\s+/).filter(Boolean).join(" ").replace(/\s+([.,!?;:])/g, "$1");
}

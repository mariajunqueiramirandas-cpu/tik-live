/** Reading viewers' answers out of chat messages, forgivingly. */

/** Lowercase, no accents, punctuation as spaces: "Letra B!" → "letra b". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const OPTION_WORDS = /^(?:letra|opcao|option|alternativa|resposta|answer|e|is|it s|its|a resposta e)?\s*([a-d])$/;

/** "B", "b)", "letra b", "2" or the option's own text → its index. */
export function readOption(text: string, options: readonly string[]): number | undefined {
  const plain = normalize(text);
  if (!plain || plain.length > 60) return undefined;
  const letter = plain.match(OPTION_WORDS)?.[1];
  if (letter) {
    const index = letter.charCodeAt(0) - 97;
    return index < options.length ? index : undefined;
  }
  if (/^[1-4]$/.test(plain)) {
    const index = Number(plain) - 1;
    return index < options.length ? index : undefined;
  }
  const index = options.findIndex((option) => normalize(option) === plain);
  return index === -1 ? undefined : index;
}

const TRUE_WORDS = new Set(["t", "true", "v", "verdadeiro", "verdade", "sim", "yes", "y", "certo"]);
const FALSE_WORDS = new Set(["f", "false", "falso", "nao", "no", "n", "mentira", "errado"]);

export function readTrueFalse(text: string): boolean | undefined {
  const plain = normalize(text);
  if (TRUE_WORDS.has(plain)) return true;
  if (FALSE_WORDS.has(plain)) return false;
  return undefined;
}

/** A whole number on its own: "42", " 42!", "-3". */
export function readNumber(text: string): number | undefined {
  const match = text.trim().match(/^(-?\d{1,5})[!.?]*$/);
  return match ? Number(match[1]) : undefined;
}

/** A single word, letters only, as typed (normalized), or undefined. */
export function readWord(text: string): string | undefined {
  const plain = normalize(text);
  return /^\p{L}{2,24}$/u.test(plain) ? plain : undefined;
}

const ARTICLES = /^(?:a|an|the|o|os|as|um|uma|el|la|los|las)\s+/;

/** Does a guess match one of the accepted answers? Articles and accents don't matter. */
export function matchesAnswer(guess: string, answers: readonly string[]): boolean {
  const plain = normalize(guess).replace(ARTICLES, "");
  if (!plain) return false;
  return answers.some((answer) => normalize(answer).replace(ARTICLES, "") === plain);
}

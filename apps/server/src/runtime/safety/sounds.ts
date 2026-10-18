/**
 * Names that sound rude out loud (ADR-0034). Pranksters ask the host to greet
 * "Tomas Turbando" or "Oscar Alho": every word is innocent on screen, but the
 * voice says "tô masturbando" and "o caralho". Text filters and the moderator
 * read spelling; this reads sound, the way Brazilian Portuguese is spoken:
 * the gaps between words disappear, k/c/qu, s/z/ç/ss, x/ch, i/y and u/w sound
 * alike, a word's last e and o sound like i and u, an h is silent and doubled
 * letters are one. Cheap and deterministic: it runs on every message, name
 * and line.
 */

/**
 * Rude words, matched as whole words (with plurals and diminutives) in any
 * spelling: "Kuzaun", "p0rra", "Vi4do". Ambiguous words that are also
 * surnames or everyday words (pinto, rola, pau, pica, cu) only count inside
 * the phrases below.
 */
const WORDS = [
  "porra", "puta", "putinha", "puto", "foda", "foder", "fuder", "fodido", "fudido", "merda", "bosta", "cacete", "caralho", "caraio",
  "buceta", "boceta", "piroca", "piru", "punheta", "xota", "xoxota", "xereca", "corno", "viado", "bicha",
  "sapatão", "traveco", "tesão", "broxa", "boquete", "cuzão", "arrombado", "putaria", "retardado", "nazista",
  // Diminutives and augmentatives, one by one: "bichinho", "cacetinho" (a bread roll) and "porrinha" (a bar game) are innocent.
  "bucetinha", "bucetão", "putão", "fodinha", "fodão", "merdinha", "bostinha", "viadinho", "viadão", "corninho", "cornão",
  "caralhinho", "pirocão", "pirocudo", "xotinha", "punheteiro", "cuzinho", "boquetinho", "tesuda", "tesudo",
  "fuck", "fucking", "shit", "bitch", "pussy", "cunt", "nigga", "nigger", "faggot",
];

/** Rude abbreviations: spelled, not sounded, so they're matched as typed ("krl" must not sound like "Cruz"). */
const ABBREVIATIONS = new Set(["fdp", "pqp", "vtnc", "vsf", "krl", "tnc", "vsfd", "tmnc"]);

/**
 * Rude sounds, matched in a name across the gaps between words: that's how
 * the pun works ("Oscar Alho"). A sound may start anywhere, but it must end
 * where a word ends, as the pun does: "Oscar Alho" is "o caralho", "Cara
 * Lucas" isn't. A trailing "*" lets a stem end mid-word ("Tomas Turbando").
 * Each is long and distinctive enough not to turn up by chance in ordinary
 * names.
 */
const SOUNDS = [
  "caralho", "buceta", "boceta", "piroca", "punheta", "siririca", "xoxota", "xereca", "putaria", "boquete", "traveco",
  "masturb*", "arrombad*", "retardad*", "hitler*",
  "sinto pinto", "pinto duro", "pau duro", "pau latejan*", "cu cabeludo", "pau no cu", "tomar no cu", "vai tomar no",
  "leite aqui no rego", "minha rola", "chupa meu", "filho da puta", "puta que pariu", "vai se foder",
  "mike hunt", "ben dover",
];

/** A rude word's plural, as it sounds. */
const SUFFIX = "s?";

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };

/** How a word sounds, as a key: "Kuzaun" and "cuzão" are both "kusau". */
export function soundOf(word: string): string {
  // Digits tacked on the end of a handle are a number, not leetspeak: "bucetinha123", "kuzaun2007".
  let w = word.toLowerCase().replace(/(?<=\p{L})\d{2,}$/u, "");
  if (/\p{L}/u.test(w)) w = w.replace(/[013457@$]/g, (c) => LEET[c] ?? c);
  w = w
    .replace(/ç/g, "s")
    .replace(/ão|ã$|am$|aum$|aun$/g, "au")
    .replace(/õe/g, "oi")
    .replace(/ãe/g, "ai")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z]/g, "");
  return w
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/sh|ch/g, "x")
    .replace(/lh/g, "l")
    .replace(/nh/g, "n")
    .replace(/qu|q/g, "k")
    .replace(/gu(?=[eiy])/g, "g")
    .replace(/c(?=[eiy])/g, "s")
    .replace(/c/g, "k")
    .replace(/g(?=[eiy])/g, "j")
    .replace(/y/g, "i")
    .replace(/w/g, "u")
    .replace(/h/g, "")
    .replace(/z/g, "s")
    // A strong rr isn't the r of "pura": "porra" mustn't sound like "pura".
    .replace(/rr/g, "R")
    // An l before a consonant or at the end sounds like u ("mal" is "mau").
    .replace(/l(?=[^aeiou]|$)/g, "u")
    // Only a word's last vowel: "peruca" (a wig) mustn't sound like "piroca".
    .replace(/e(s?)$/, "i$1")
    .replace(/o(s?)$/, "u$1")
    .replace(/(.)\1+/g, "$1");
}

/** The words of `text`, with letters spelled out one by one ("p o r r a") joined back into a word. */
function words(text: string): string[] {
  const out: string[] = [];
  let spelled = "";
  for (const word of text.split(/[^\p{L}\p{N}@$]+/u).filter(Boolean)) {
    if (word.length === 1 && /\p{L}/u.test(word)) {
      spelled += word;
      continue;
    }
    if (spelled) out.push(spelled);
    spelled = "";
    out.push(word);
  }
  if (spelled) out.push(spelled);
  return out;
}

const keyOf = (phrase: string) => phrase.split(" ").map(soundOf).join("");
const WORD_KEYS = new RegExp(`^(?:${[...new Set(WORDS.map(keyOf))].join("|")})${SUFFIX}$`);
const SOUND_KEYS = SOUNDS.map((sound) => ({ key: keyOf(sound.replace(/\*$/, "")), stem: sound.endsWith("*") }));

function rudeWord(word: string): boolean {
  if (ABBREVIATIONS.has(word.toLowerCase())) return true;
  const key = soundOf(word);
  return key !== "" && WORD_KEYS.test(key);
}

function rudeSound(span: readonly string[]): boolean {
  let key = "";
  const ends = new Set<number>();
  for (const word of span) {
    key += soundOf(word);
    ends.add(key.length);
  }
  return SOUND_KEYS.some((sound) => {
    for (let at = key.indexOf(sound.key); at !== -1; at = key.indexOf(sound.key, at + 1)) {
      if (sound.stem || ends.has(at + sound.key.length)) return true;
    }
    return false;
  });
}

/**
 * True when a name sounds rude out loud: a rude word in any spelling, a rude
 * sound across its words ("Oscar Alho"), or the whole name said as one word
 * ("Po Rra"). For nicknames, which the host says on air.
 */
export function nameSoundsRude(name: string): boolean {
  const parts = words(name);
  if (!parts.length) return false;
  return parts.some(rudeWord) || rudeSound(parts) || (parts.length <= 3 && rudeWord(parts.join("")));
}

/** Where a clause ends: a name doesn't run across it. */
const CLAUSE = /[.,!?;:\n]/;

/** Words that come right before a name someone wants said: a shout-out, a greeting, "say ...". */
const NAME_CUE = new RegExp(
  "(?:^|[^\\p{L}])(?:salve|salves|oi|ola|olá|alo|alô|beijo|beijos|beijao|beijão|abraço|abraco|abraços|parabens|parabéns|manda|mande|fala|fale|diga|diz|chama|chame|le|lê|leia|repete|repita|pronuncia|pronuncie|cumprimenta|valeu|obrigado|obrigada|bem-vindo|bem-vinda)(?=[^\\p{L}]|$)",
  "giu",
);

/** Words between a cue and the name: "manda um salve pro meu amigo ...". */
const FILLER = new Set(
  "um uma uns umas pro pra pros pras para ao aos à às a o os as meu minha meus minhas nosso nossa seu sua do da de e ai aí la lá amigo amiga amigos amigas primo prima irmão irmao irmã irma mãe mae pai tio tia vó vo vô avó avô namorado namorada mano mana salve oi beijo beijos beijão abraço abraco grande querido querida também tambem".split(" "),
);
/** Words that show what follows a cue is a sentence, not a name: "oi gente, essa live é ...", "obrigado pela live ...", "fala sério ...". */
const NOT_A_NAME = new Set(
  "é que isso essa esse este esta aqui tá ta to tô foi vai tem eu vc você voce sou são sao muito demais pela pelo por sério serio gente live galera todos todo mundo pessoal chat".split(" "),
);
/** A name is a few words long. */
const NAME_WORDS = 3;

/** The words right after a cue that would be the name, skipping "um salve pro meu amigo"; none when a sentence follows instead. */
function nameAfterCue(rest: readonly string[]): string[] {
  const name: string[] = [];
  for (const word of rest) {
    const lower = word.toLowerCase();
    if (NOT_A_NAME.has(lower)) break;
    if (FILLER.has(lower)) continue;
    name.push(word);
    if (name.length === NAME_WORDS) break;
  }
  return name;
}

interface NameSpan {
  words: string[];
  /** Whether these words are the name itself, so a plain rude word counts; otherwise only a pun across them does. */
  isName: boolean;
}

/**
 * The parts of `text` that could carry a name. Runs of two or more
 * capitalized words, and the rest of a clause after a shout-out or a
 * "say ...", are checked for puns ("Cuca Beludo mandou um oi"). The few
 * words right after the cue are the name itself, where a plain rude word
 * counts too ("manda um salve pro Kuzaun"): further on, a swear word is just
 * how someone talks ("oi gente, essa live é foda demais").
 */
function nameSpans(text: string): NameSpan[] {
  const spans: NameSpan[] = [];
  for (const clause of text.split(CLAUSE)) {
    let run: string[] = [];
    for (const word of clause.split(/[^\p{L}\p{N}@$]+/u)) {
      if (/^\p{Lu}/u.test(word)) {
        run.push(word);
        continue;
      }
      if (run.length > 1) spans.push({ words: run, isName: false });
      run = [];
    }
    if (run.length > 1) spans.push({ words: run, isName: false });
  }
  for (const match of text.matchAll(NAME_CUE)) {
    const rest = words(text.slice((match.index ?? 0) + match[0].length).split(CLAUSE)[0] ?? "");
    if (rest.length) spans.push({ words: rest, isName: false });
    const name = nameAfterCue(rest);
    if (name.length) spans.push({ words: name, isName: true });
  }
  return spans;
}

/**
 * True when a message asks the host to say a name that sounds rude ("manda
 * um salve pro meu amigo Tomas Turbando"). Plain swearing elsewhere in a
 * message doesn't count here: the host was never going to say that.
 */
export function asksForRudeName(text: string): boolean {
  return nameSpans(text).some((span) => (span.isName && span.words.some(rudeWord)) || rudeSound(span.words));
}

/** True when a line the host is about to say sounds rude: any rude word in any spelling, or a rude-sounding name. */
export function lineSoundsRude(text: string): boolean {
  return words(text).some(rudeWord) || asksForRudeName(text);
}

/** "Manda um salve pro...", "fala oi pra...": a viewer asking the host to greet someone, usually by name. */
const SHOUT_OUT = /(?:^|[^\p{L}])(?:salves?|manda(?:r)? (?:um |uns )?(?:oi|beijos?|abraços?|abracos?|alô|alo)|parab[eé]ns|fala (?:um )?oi|um grito)(?=[^\p{L}]).{0,20}?(?:^|[^\p{L}])(?:pro|pra|para|ao|à|a|pros|pras)(?=[^\p{L}]|$)/iu;

/** True when a message asks the host for a shout-out: the turn reminds the host to say only a name that sounds fine. */
export function asksForShoutout(text: string): boolean {
  return SHOUT_OUT.test(text);
}

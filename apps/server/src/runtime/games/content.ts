import type { GameKind, GeneratedKind } from "@tik-live/shared";
import { normalize } from "./answers";

/** One round's material. The generated kinds are made up on the spot (ADR-0038); the rest are written. */
export type RoundContent =
  | { kind: "trivia"; question: string; options: string[]; correct: number }
  | { kind: "poll"; question: string; options: string[] }
  | { kind: "scramble"; word: string; hint: string }
  | { kind: "number"; min: number; max: number; secret: number }
  | { kind: "truefalse"; statement: string; answer: boolean }
  | { kind: "math"; expression: string; answer: number }
  | { kind: "riddle"; riddle: string; answers: string[]; hint: string }
  | { kind: "fastest"; word: string }
  | { kind: "tug"; teams: [string, string] }
  | { kind: "potato"; fuseMs: number };

export type WrittenKind = Exclude<GameKind, GeneratedKind>;
export type BankLanguage = "en" | "pt";

/**
 * The offline question bank: used by hosts without a model, and to fill in
 * when writing fails or a written round is blocked by moderation. Facts are
 * kept to the kind nobody argues about.
 */
export const BANK: Record<BankLanguage, { [K in WrittenKind]: Array<Extract<RoundContent, { kind: K }>> }> = {
  en: {
    trivia: [
      t("Which planet is the largest in our solar system?", ["Saturn", "Jupiter", "Neptune", "Earth"], 1),
      t("How many legs does a spider have?", ["Six", "Ten", "Eight", "Twelve"], 2),
      t("What color do you get mixing blue and yellow?", ["Green", "Purple", "Orange", "Brown"], 0),
      t("Which animal is known as the king of the jungle?", ["Tiger", "Elephant", "Lion", "Gorilla"], 2),
      t("How many days are in a leap year?", ["365", "366", "364", "360"], 1),
      t("What is the freezing point of water in Celsius?", ["0 degrees", "10 degrees", "32 degrees", "100 degrees"], 0),
      t("Which ocean is the largest?", ["Atlantic", "Indian", "Arctic", "Pacific"], 3),
      t("How many continents are there?", ["Five", "Six", "Seven", "Eight"], 2),
      t("What do bees make?", ["Milk", "Honey", "Silk", "Wax paper"], 1),
      t("Which shape has three sides?", ["Square", "Triangle", "Circle", "Hexagon"], 1),
      t("What is the closest star to Earth?", ["The Sun", "Sirius", "Polaris", "Vega"], 0),
      t("How many minutes are in an hour?", ["100", "30", "60", "90"], 2),
      t("Which fruit is famous for keeping the doctor away?", ["Banana", "Apple", "Grape", "Mango"], 1),
      t("What is the largest mammal?", ["Elephant", "Blue whale", "Giraffe", "Hippo"], 1),
      t("Which instrument has 88 keys?", ["Guitar", "Violin", "Piano", "Flute"], 2),
      t("What gas do plants take in from the air?", ["Oxygen", "Helium", "Carbon dioxide", "Nitrogen"], 2),
      t("How many colors are in a rainbow?", ["Five", "Six", "Seven", "Nine"], 2),
      t("Which is the fastest land animal?", ["Cheetah", "Horse", "Lion", "Ostrich"], 0),
      t("What is the tallest animal?", ["Elephant", "Giraffe", "Camel", "Moose"], 1),
      t("Which planet is called the Red Planet?", ["Venus", "Mars", "Mercury", "Jupiter"], 1),
    ],
    poll: [
      p("Pizza or burgers?", ["Pizza", "Burgers"]),
      p("Beach or mountains?", ["Beach", "Mountains"]),
      p("Cats or dogs?", ["Cats", "Dogs"]),
      p("Morning person or night owl?", ["Morning", "Night owl"]),
      p("Sweet or salty snacks?", ["Sweet", "Salty"]),
      p("Fly like a bird or breathe underwater?", ["Fly", "Underwater"]),
      p("Summer or winter?", ["Summer", "Winter"]),
      p("Movies at home or at the cinema?", ["Home", "Cinema"]),
      p("Texting or calling?", ["Texting", "Calling"]),
      p("Be invisible or read minds?", ["Invisible", "Read minds"]),
      p("Pancakes or waffles?", ["Pancakes", "Waffles"]),
      p("Time travel to the past or the future?", ["Past", "Future"]),
      p("Live in a castle or a spaceship?", ["Castle", "Spaceship"]),
      p("Ice cream: cone or cup?", ["Cone", "Cup"]),
      p("Talk to animals or speak every language?", ["Animals", "Every language"]),
    ],
    scramble: [
      s("PLANET", "It orbits a star"),
      s("GUITAR", "Six strings"),
      s("BANANA", "Yellow and curved"),
      s("PENGUIN", "A bird that can't fly"),
      s("RAINBOW", "After the rain"),
      s("PIZZA", "Sliced and shared"),
      s("CASTLE", "Kings live here"),
      s("ROCKET", "Goes to space"),
      s("DRAGON", "Breathes fire"),
      s("COOKIE", "Sweet and crunchy"),
      s("JUNGLE", "Full of trees and vines"),
      s("WINTER", "The cold season"),
      s("GALAXY", "Billions of stars"),
      s("PIRATE", "Arr, treasure!"),
      s("TURTLE", "Carries its home"),
      s("BALLOON", "Floats at parties"),
      s("CAMERA", "Takes pictures"),
      s("ORANGE", "A fruit and a color"),
      s("SPIDER", "Spins webs"),
      s("THUNDER", "Comes after lightning"),
    ],
    truefalse: [
      tf("Octopuses have three hearts.", true),
      tf("The Sun is a planet.", false),
      tf("Bananas grow on trees that are technically herbs.", true),
      tf("Penguins live at the North Pole.", false),
      tf("Water boils at 100 degrees Celsius at sea level.", true),
      tf("Spiders are insects.", false),
      tf("A group of crows is called a murder.", true),
      tf("The Moon has its own light.", false),
      tf("Honey can last for thousands of years.", true),
      tf("Bats are blind.", false),
      tf("Sharks are fish.", true),
      tf("The Great Wall of China is visible from the Moon with bare eyes.", false),
      tf("A tomato is a fruit.", true),
      tf("Humans have four lungs.", false),
      tf("A day on Venus is longer than a year on Venus.", true),
    ],
    riddle: [
      r("What has hands but can't clap?", ["clock", "a clock", "watch"], "It tells you something"),
      r("What gets wetter the more it dries?", ["towel", "a towel"], "Bathroom"),
      r("What has keys but can't open locks?", ["piano", "a piano", "keyboard"], "Music"),
      r("What has a neck but no head?", ["bottle", "a bottle"], "You drink from it"),
      r("What goes up but never comes down?", ["age", "your age"], "Birthdays"),
      r("What has one eye but can't see?", ["needle", "a needle"], "Sewing"),
      r("What can you catch but not throw?", ["cold", "a cold"], "Achoo"),
      r("What has many teeth but can't bite?", ["comb", "a comb", "zipper"], "Hair"),
      r("What runs but never walks?", ["water", "river", "a river"], "Nature"),
      r("What has a face and two hands but no arms?", ["clock", "a clock"], "Tick tock"),
    ],
    fastest: [
      f("BANANA"), f("ROCKET"), f("PIZZA"), f("GALAXY"), f("TURTLE"), f("DRAGON"), f("COOKIE"), f("LASER"),
      f("PICKLE"), f("WAFFLE"), f("JUNGLE"), f("NINJA"), f("PLANET"), f("BUBBLE"), f("TACO"), f("MANGO"),
    ],
  },
  pt: {
    trivia: [
      t("Qual é o maior planeta do sistema solar?", ["Saturno", "Júpiter", "Netuno", "Terra"], 1),
      t("Quantas patas tem uma aranha?", ["Seis", "Dez", "Oito", "Doze"], 2),
      t("Que cor sai da mistura de azul com amarelo?", ["Verde", "Roxo", "Laranja", "Marrom"], 0),
      t("Qual animal é chamado de rei da selva?", ["Tigre", "Elefante", "Leão", "Gorila"], 2),
      t("Quantos dias tem um ano bissexto?", ["365", "366", "364", "360"], 1),
      t("Qual é a capital do Brasil?", ["São Paulo", "Rio de Janeiro", "Brasília", "Salvador"], 2),
      t("Qual é o maior oceano do mundo?", ["Atlântico", "Índico", "Ártico", "Pacífico"], 3),
      t("Quantos continentes existem?", ["Cinco", "Seis", "Sete", "Oito"], 2),
      t("O que as abelhas produzem?", ["Leite", "Mel", "Seda", "Papel"], 1),
      t("Qual forma tem três lados?", ["Quadrado", "Triângulo", "Círculo", "Hexágono"], 1),
      t("Qual é a estrela mais próxima da Terra?", ["O Sol", "Sirius", "Estrela Polar", "Vega"], 0),
      t("Quantos minutos tem uma hora?", ["100", "30", "60", "90"], 2),
      t("Qual é o maior mamífero do mundo?", ["Elefante", "Baleia-azul", "Girafa", "Hipopótamo"], 1),
      t("Qual instrumento tem 88 teclas?", ["Violão", "Violino", "Piano", "Flauta"], 2),
      t("Qual é o maior rio do Brasil em volume de água?", ["São Francisco", "Amazonas", "Paraná", "Tietê"], 1),
      t("Quantas cores tem o arco-íris?", ["Cinco", "Seis", "Sete", "Nove"], 2),
      t("Qual é o animal terrestre mais rápido?", ["Guepardo", "Cavalo", "Leão", "Avestruz"], 0),
      t("Qual é o animal mais alto do mundo?", ["Elefante", "Girafa", "Camelo", "Alce"], 1),
      t("Qual planeta é conhecido como Planeta Vermelho?", ["Vênus", "Marte", "Mercúrio", "Júpiter"], 1),
      t("Quantos jogadores um time de futebol tem em campo?", ["Nove", "Dez", "Onze", "Doze"], 2),
    ],
    poll: [
      p("Pizza ou hambúrguer?", ["Pizza", "Hambúrguer"]),
      p("Praia ou montanha?", ["Praia", "Montanha"]),
      p("Gato ou cachorro?", ["Gato", "Cachorro"]),
      p("Acordar cedo ou virar a noite?", ["Cedo", "Virar a noite"]),
      p("Doce ou salgado?", ["Doce", "Salgado"]),
      p("Voar ou respirar debaixo d'água?", ["Voar", "Debaixo d'água"]),
      p("Verão ou inverno?", ["Verão", "Inverno"]),
      p("Filme em casa ou no cinema?", ["Em casa", "Cinema"]),
      p("Áudio ou mensagem de texto?", ["Áudio", "Texto"]),
      p("Ficar invisível ou ler mentes?", ["Invisível", "Ler mentes"]),
      p("Coxinha ou pastel?", ["Coxinha", "Pastel"]),
      p("Viajar pro passado ou pro futuro?", ["Passado", "Futuro"]),
      p("Morar num castelo ou numa nave espacial?", ["Castelo", "Nave"]),
      p("Açaí ou sorvete?", ["Açaí", "Sorvete"]),
      p("Falar com animais ou falar todas as línguas?", ["Animais", "Todas as línguas"]),
    ],
    scramble: [
      s("PLANETA", "Gira em volta de uma estrela"),
      s("VIOLAO", "Seis cordas"),
      s("BANANA", "Amarela e curvinha"),
      s("PINGUIM", "Uma ave que não voa"),
      s("PIPOCA", "Combina com filme"),
      s("CASTELO", "Onde moram os reis"),
      s("FOGUETE", "Vai pro espaço"),
      s("DRAGAO", "Solta fogo"),
      s("BISCOITO", "Doce e crocante"),
      s("FLORESTA", "Cheia de árvores"),
      s("INVERNO", "A estação fria"),
      s("GALAXIA", "Bilhões de estrelas"),
      s("PIRATA", "Procura tesouro"),
      s("TARTARUGA", "Carrega a casa nas costas"),
      s("BALAO", "Flutua nas festas"),
      s("CAMERA", "Tira fotos"),
      s("LARANJA", "Uma fruta e uma cor"),
      s("ARANHA", "Faz teias"),
      s("TROVAO", "Vem depois do relâmpago"),
      s("BRIGADEIRO", "Doce de festa"),
    ],
    truefalse: [
      tf("O polvo tem três corações.", true),
      tf("O Sol é um planeta.", false),
      tf("O tomate é uma fruta.", true),
      tf("Pinguins vivem no Polo Norte.", false),
      tf("A água ferve a 100 graus Celsius ao nível do mar.", true),
      tf("Aranhas são insetos.", false),
      tf("O Brasil é o maior país da América do Sul.", true),
      tf("A Lua tem luz própria.", false),
      tf("O mel pode durar milhares de anos.", true),
      tf("Morcegos são cegos.", false),
      tf("Tubarões são peixes.", true),
      tf("A Grande Muralha da China pode ser vista da Lua a olho nu.", false),
      tf("O coração humano tem quatro cavidades.", true),
      tf("Os seres humanos têm quatro pulmões.", false),
      tf("O beija-flor consegue voar para trás.", true),
    ],
    riddle: [
      r("O que é, o que é: tem mãos mas não bate palmas?", ["relogio", "o relogio", "um relogio"], "Marca alguma coisa"),
      r("O que é, o que é: quanto mais seca, mais molhada fica?", ["toalha", "a toalha", "uma toalha"], "Banheiro"),
      r("O que é, o que é: tem teclas mas não abre fechaduras?", ["piano", "o piano", "teclado"], "Música"),
      r("O que é, o que é: tem pescoço mas não tem cabeça?", ["garrafa", "a garrafa", "uma garrafa"], "Você bebe dela"),
      r("O que é, o que é: sobe e nunca desce?", ["idade", "a idade"], "Aniversários"),
      r("O que é, o que é: tem um olho só e não enxerga?", ["agulha", "a agulha", "uma agulha"], "Costura"),
      r("O que é, o que é: cai em pé e corre deitado?", ["chuva", "a chuva"], "Vem do céu"),
      r("O que é, o que é: tem dentes mas não morde?", ["pente", "o pente", "um pente", "ziper"], "Cabelo"),
      r("O que é, o que é: anda com os pés na cabeça?", ["piolho", "o piolho"], "Bichinho chato"),
      r("O que é, o que é: quanto mais se tira, maior fica?", ["buraco", "o buraco", "um buraco"], "Pá"),
    ],
    fastest: [
      f("BANANA"), f("FOGUETE"), f("PIPOCA"), f("GALAXIA"), f("PIRATA"), f("DRAGAO"), f("COXINHA"), f("LASER"),
      f("PASTEL"), f("ABACAXI"), f("FLORESTA"), f("NINJA"), f("PLANETA"), f("BOLHA"), f("TACO"), f("MANGA"),
    ],
  },
};

function t(question: string, options: string[], correct: number): Extract<RoundContent, { kind: "trivia" }> {
  return { kind: "trivia", question, options, correct };
}
function p(question: string, options: string[]): Extract<RoundContent, { kind: "poll" }> {
  return { kind: "poll", question, options };
}
function s(word: string, hint: string): Extract<RoundContent, { kind: "scramble" }> {
  return { kind: "scramble", word, hint };
}
function tf(statement: string, answer: boolean): Extract<RoundContent, { kind: "truefalse" }> {
  return { kind: "truefalse", statement, answer };
}
function r(riddle: string, answers: string[], hint: string): Extract<RoundContent, { kind: "riddle" }> {
  return { kind: "riddle", riddle, answers, hint };
}
function f(word: string): Extract<RoundContent, { kind: "fastest" }> {
  return { kind: "fastest", word };
}

/** Rough guess at chat's language from a few messages: Portuguese or English. */
export function guessLanguage(speechLanguage: string | undefined, sample: readonly string[]): BankLanguage {
  if (speechLanguage) return speechLanguage.toLowerCase().startsWith("pt") ? "pt" : "en";
  const words = sample.join(" ").toLowerCase().split(/[^\p{L}]+/u);
  const pt = new Set(["que", "não", "nao", "você", "voce", "tá", "ta", "é", "oi", "eu", "de", "um", "uma", "muito", "kkk", "kkkk", "aí", "ai", "pra", "mano", "cara", "tudo", "bem"]);
  const en = new Set(["the", "you", "is", "are", "what", "hi", "hello", "lol", "and", "this", "that", "my", "i", "it", "how"]);
  let score = 0;
  for (const word of words) {
    if (pt.has(word)) score += 1;
    else if (en.has(word)) score -= 1;
  }
  return score > 0 ? "pt" : "en";
}

/** Picks `count` items, the ones not played yet first. */
export function pickFromBank<K extends WrittenKind>(
  language: BankLanguage,
  kind: K,
  count: number,
  played: (item: RoundContent) => boolean,
  random: () => number,
): Array<Extract<RoundContent, { kind: K }>> {
  const all = BANK[language][kind] as Array<Extract<RoundContent, { kind: K }>>;
  const fresh = all.filter((item) => !played(item));
  const stale = all.filter((item) => played(item));
  return [...shuffle(fresh, random), ...shuffle(stale, random)].slice(0, count);
}

/** A stable identity for a round, to avoid repeats within a stream. */
export function contentKey(content: RoundContent): string {
  switch (content.kind) {
    case "trivia":
    case "poll":
      return `${content.kind}:${content.question}`;
    case "truefalse":
      return `${content.kind}:${content.statement}`;
    case "riddle":
      return `${content.kind}:${content.riddle}`;
    case "scramble":
    case "fastest":
      return `${content.kind}:${content.word}`;
    case "number":
      return `number:${content.secret}`;
    case "math":
      return `math:${content.expression}`;
    case "tug":
      return `tug:${content.teams.join("|")}`;
    case "potato":
      return `potato:${content.fuseMs}`;
  }
}

/** The round in one line for the writer's avoid list, answer included, so the same fact reworded is easy to spot. */
export function avoidLine(content: RoundContent): string {
  switch (content.kind) {
    case "trivia":
      return `${content.question} → ${content.options[content.correct] ?? ""}`;
    case "poll":
      return `${content.question} (${content.options.join(" / ")})`;
    case "truefalse":
      return content.statement;
    case "riddle":
      return `${content.riddle} → ${content.answers[0] ?? ""}`;
    case "scramble":
    case "fastest":
      return content.word;
    case "number":
      return String(content.secret);
    case "math":
      return content.expression;
    case "tug":
      return content.teams.join(" x ");
    case "potato":
      return "batata quente";
  }
}

/** Words too common to tell two questions apart. Words of one or two letters are dropped anyway. */
const FILLER_WORDS = new Set(
  "que qual quais quem quanto quanta quantos quantas onde como uma uns umas dos das nos nas num numa por para pra com sem mais seu sua seus suas esse essa este esta isso isto ele ela eles elas tem sao ser foi verdade the what which who how many much does did are was were and for with this that its true".split(" "),
);

function contentWords(text: string): Set<string> {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((w) => w.length > 2 && !FILLER_WORDS.has(w)),
  );
}

/** How much two texts share, from 0 (nothing) to 1 (the same words). */
function overlap(a: string, b: string): number {
  const x = contentWords(a);
  const y = contentWords(b);
  if (x.size === 0 || y.size === 0) return normalize(a) === normalize(b) ? 1 : 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

/**
 * Whether two rounds are the same idea, even worded differently: "Qual é o
 * maior planeta?" and "Qual o maior planeta do sistema solar?" are one
 * question to chat, and so are two riddles with the same answer.
 */
export function sameIdea(a: RoundContent, b: RoundContent): boolean {
  if (a.kind !== b.kind) return false;
  if (contentKey(a) === contentKey(b)) return true;
  switch (a.kind) {
    case "trivia": {
      const other = b as typeof a;
      const sameAnswer = normalize(a.options[a.correct] ?? "") === normalize(other.options[other.correct] ?? "");
      const similar = overlap(a.question, other.question);
      return similar >= 0.7 || (sameAnswer && similar >= 0.4);
    }
    case "poll": {
      const other = b as typeof a;
      const options = (round: typeof a) => round.options.map(normalize).sort().join("|");
      return options(a) === options(other) || overlap(a.question, other.question) >= 0.7;
    }
    case "truefalse":
      return overlap(a.statement, (b as typeof a).statement) >= 0.6;
    case "riddle": {
      const other = b as typeof a;
      return normalize(a.answers[0] ?? "") === normalize(other.answers[0] ?? "") || overlap(a.riddle, other.riddle) >= 0.6;
    }
    case "scramble":
    case "fastest":
      return normalize(a.word) === normalize((b as typeof a).word);
    default:
      return false;
  }
}

/** What a batch of rounds can be about when there's no topic, so batches don't all draw the same famous questions. */
const THEMES: Record<WrittenKind, readonly string[]> = {
  trivia: [
    "animals", "the human body", "space", "geography of Brazil", "world geography", "food and cooking", "music", "football",
    "other sports", "inventions", "everyday science", "the ocean", "plants", "dinosaurs", "cartoons and animated films",
    "video games", "world records", "language and words", "Brazilian culture and holidays", "famous landmarks",
    "weather", "numbers and shapes", "history of everyday objects", "insects", "birds", "fruits and vegetables",
  ],
  truefalse: [
    "animals", "the human body", "space", "food", "the ocean", "plants", "history of everyday objects", "sleep",
    "insects", "weather", "geography", "inventions", "sports", "language and words", "common myths", "dinosaurs",
  ],
  riddle: ["objects at home", "nature", "the body", "time and calendars", "food", "school things", "weather", "animals", "word play", "music"],
  poll: [
    "food", "superpowers", "travel", "daily routine", "school and work", "music", "games", "animals", "weird hypotheticals",
    "holidays", "technology", "fashion", "movies and series", "weekends", "the future", "Brazilian snacks",
  ],
  scramble: ["the kitchen", "animals", "fruits", "school", "sports", "nature", "the house", "clothes", "transport", "jobs", "instruments", "weather", "the beach", "toys"],
  fastest: ["animals", "food", "colors", "nature", "the house", "sports", "music", "the beach", "space", "toys", "clothes", "the city"],
};

/** A few themes for the next batch, drawn at random. */
export function pickThemes(kind: WrittenKind, random: () => number, count = 3): string[] {
  return shuffle(THEMES[kind], random).slice(0, count);
}

export function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A sum for "Quick math", harder as the rounds go on. Results stay whole and positive. */
export function makeMath(round: number, random: () => number): Extract<RoundContent, { kind: "math" }> {
  const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
  const level = Math.min(3, Math.floor((round - 1) / 2));
  switch (level) {
    case 0: {
      const a = int(3, 19);
      const b = int(3, 19);
      return { kind: "math", expression: `${a} + ${b}`, answer: a + b };
    }
    case 1: {
      const a = int(3, 9);
      const b = int(3, 9);
      return { kind: "math", expression: `${a} × ${b}`, answer: a * b };
    }
    case 2: {
      const a = int(3, 9);
      const b = int(3, 9);
      const c = int(2, 20);
      return { kind: "math", expression: `${a} × ${b} + ${c}`, answer: a * b + c };
    }
    default: {
      const a = int(2, 9);
      const b = int(2, 9);
      const c = int(2, 6);
      const d = int(1, Math.min(9, (a + b) * c - 1));
      return { kind: "math", expression: `(${a} + ${b}) × ${c} − ${d}`, answer: (a + b) * c - d };
    }
  }
}

export function makeNumber(random: () => number): Extract<RoundContent, { kind: "number" }> {
  return { kind: "number", min: 1, max: 100, secret: 1 + Math.floor(random() * 100) };
}

/** Shuffles a word's letters so the result never reads as the word itself. */
export function scrambleLetters(word: string, random: () => number): string {
  const letters = [...word.toUpperCase()];
  if (new Set(letters).size < 2) return letters.join("");
  for (let attempt = 0; attempt < 12; attempt++) {
    const out = shuffle(letters, random).join("");
    if (out !== word.toUpperCase()) return out;
  }
  return [...letters.slice(1), letters[0]].join("");
}

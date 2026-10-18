/** A Fish Audio voice creators can pick (ADR-0028). */
export interface FishVoice {
  /** Fish Audio's voice (model) id: 32 hex characters. */
  id: string;
  name: string;
  description: string | null;
  tags: string[];
}

export const FISH_VOICE_ID = /^[0-9a-f]{32}$/;

/**
 * The built-in voices: Brazilian voices from Fish Audio's public library,
 * each made with Fish's voice designer from a written description, so none
 * imitates a real person. Each was checked on Drama 3 for a native Brazilian
 * accent, the same speaker from line to line, and live-host energy (ADR-0028).
 * The names are ours; each comment keeps the voice's Fish title and author.
 */
export const FISH_VOICES: FishVoice[] = [
  // "Womann" by Erin Davidson
  {
    id: "4b0adc6775774eb48b92c7e99ac92a89",
    name: "Bia",
    description: "Animada e carismática, com um sotaque mineiro leve. Fala direto com quem está assistindo.",
    tags: ["feminina", "animada", "mineira"],
  },
  // "Joana" by Leonardo Maciel Fonseca
  {
    id: "fabe2062690c46cc83038f13e2920fbb",
    name: "Joana",
    description: "Clara e simpática, com sotaque neutro.",
    tags: ["feminina", "clara", "simpática"],
  },
  // "passos123" by Tokfy 3
  {
    id: "b31f163319d040ce9a880d204652e154",
    name: "Carol",
    description: "Confiante e sorridente, com jeito de influenciadora.",
    tags: ["feminina", "confiante", "elegante"],
  },
  // "Voz de gamer" by Felipe Meneses
  {
    id: "b5e67744e9ae4c0784fac789ad7c580d",
    name: "Theo",
    description: "Jovem e cheia de energia, ótima para games e reações.",
    tags: ["masculina", "jovem", "enérgica"],
  },
  // "PNL SAMUEL" by Samuel Piva
  {
    id: "239acb170ad745a3a9667e499bcc34ca",
    name: "Samuel",
    description: "Grave e acolhedora, com um leve rouco.",
    tags: ["masculina", "grave", "acolhedora"],
  },
  // "Knowing - Br - Hombre" by contacto
  {
    id: "da04d0f7eeb54774b7baa804c4818303",
    name: "Lucas",
    description: "Tranquila e próxima, como um papo entre amigos.",
    tags: ["masculina", "jovem", "tranquila"],
  },
];

/** Bia: the highest-rated voice for a live host in the checks behind ADR-0028. */
export const DEFAULT_FISH_VOICE = "4b0adc6775774eb48b92c7e99ac92a89";

/**
 * Reads FISH_TTS_VOICES, a list that replaces the built-in voices:
 * comma-separated `id=Name` pairs. Returns the problem as a string when the
 * value is malformed.
 */
export function parseFishVoices(value: string): FishVoice[] | string {
  const voices: FishVoice[] = [];
  for (const entry of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const match = /^([0-9a-f]{32})\s*=\s*(.{1,40})$/.exec(entry);
    if (!match) return `"${entry.slice(0, 60)}" isn't id=Name (a 32-character Fish Audio voice id, then a name of up to 40 characters)`;
    const id = match[1] as string;
    if (voices.some((voice) => voice.id === id)) return `voice ${id} is listed twice`;
    voices.push({ id, name: (match[2] as string).trim(), description: null, tags: [] });
  }
  return voices.length ? voices : "lists no voices";
}

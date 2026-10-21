import { clip, wellFormed, type LiveEvent, type Viewer } from "@tik-live/shared";

/**
 * The last word on what a live event may contain, whatever its source
 * (TikTok, the simulator, an event the owner typed in the studio). Viewer
 * text is anything a stranger can type or paste: broken emoji halves,
 * invisible characters, bidi overrides, zalgo, "fancy font" letters,
 * hidden tag-character text, a thousand "k"s. Each one either crashes
 * something downstream (the Claude API refuses a request with half an
 * emoji), slips past the blocklist, or makes the voice read garbage.
 */

export const LIMITS = {
  text: 300,
  name: 40,
  id: 64,
  reason: 200,
  /** Combining marks kept on one character: enough for any real script, not for zalgo. */
  marks: 3,
  /** One character repeated more than this is cut back ("kkkkkkkkkkkk" reads as a laugh, not a minute of k). */
  repeat: 8,
  count: 10_000,
  /** The priciest TikTok gift is under 45k diamonds. */
  diamondsPerGift: 50_000,
  viewers: 10_000_000,
  likesTotal: 1_000_000_000_000,
  /** A verification window an hour or longer is not something TikTok sends; cap it anyway. */
  verifySeconds: 3_600,
} as const;

/**
 * Characters that render as nothing (or reorder what's around them): zero-width
 * spaces and joiners outside emoji, bidi controls, fillers used for "blank"
 * names, the soft hyphen, and tag characters (U+E0000 to U+E007F), which can
 * smuggle invisible text to a model.
 */
const INVISIBLE =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF0-\uFFF8]|\uDB40[\uDC00-\uDC7F]/g;
/** A zero-width joiner only belongs between emoji (👨\u200D👩\u200D👧). */
const STRAY_JOINER = /(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
/** Line breaks and other controls; viewer text is one line. */
const CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
const SPACES = /[\s\u2800]+/g;
const ZALGO = new RegExp(`(\\p{M}{${LIMITS.marks}})\\p{M}+`, "gu");
/** Digits excepted: "1000000000" is a number, not a flood. */
const RUN = new RegExp(`(\\P{N})\\1{${LIMITS.repeat},}`, "gsu");

/** One line of viewer text, cleaned: empty if nothing readable is left. */
export function cleanText(value: unknown, max: number = LIMITS.text): string {
  if (typeof value !== "string") return "";
  const text = wellFormed(value)
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(STRAY_JOINER, "")
    .replace(CONTROLS, " ")
    .replace(ZALGO, "$1")
    .replace(SPACES, " ")
    .replace(RUN, (_run, char: string) => char.repeat(LIMITS.repeat))
    .trim();
  // A cut can leave an emoji's joiner dangling at the end.
  return clip(text, max).replace(/[\u200D\s]+$/u, "");
}

/** Letter look-alikes NFKC leaves alone: small capitals. */
const SMALL_CAPS = pairs("ᴀaʙbᴄcᴅdᴇeꜰfɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpǫqʀrꜱsᴛtᴜuᴠvᴡwʏyᴢz");
/** Cyrillic and Greek letters that pass for Latin ones; folded only inside a word that also has Latin letters. */
const CONFUSABLES = pairs(
  "\u0430a\u0435e\u043Eo\u0440p\u0441c\u0443y\u0445x\u0456i\u0458j\u0455s\u0501d\u051Bq\u051Dw\u04BBh\u04CFl\u0410A\u0412B\u0415E\u041AK\u041CM\u041DH\u041EO\u0420P\u0421C\u0422T\u0425X\u0423Y\u0406I\u0408J\u0405S" +
    "\u03B1a\u03B9i\u03BAk\u03BDv\u03BFo\u03C1p\u03C4t\u03C5u\u03C7x\u0391A\u0392B\u0395E\u0396Z\u0397H\u0399I\u039AK\u039CM\u039DN\u039FO\u03A1P\u03A4T\u03A5Y\u03A7X",
);
const CONFUSABLE = new RegExp(`[${[...CONFUSABLES.keys()].join("")}]`, "g");
/** Overlays drawn over or around letters (underline, strikethrough, an enclosing circle); not the keycap (U+20E3) emoji use. */
const DECORATION_MARKS = /[\u0332-\u0338\u0489\u20D0-\u20E2\u20E4-\u20F0]/g;
/** Symbols names are framed with, like "꧁༺ Maria ༻꧂" or "★彡Maria彡★"; stripped from both ends with plain punctuation. */
const FRAME =
  "꧁꧂༺༻彡★☆✦✧✩✪✫✬✭✮✯✰⋆✿❀❁✾❦❧☬☾☽⚝•·°×«»【】『』「」〖〗〘〙《》〔〕︻︼╰╯▄█▀▓▒░▬┃│";
const FRAME_EDGES = new RegExp(`^[${FRAME}\\s|~^\`'"\\-_=+*#.:;,<>()\\[\\]{}!?]+|[${FRAME}\\s|~^\`'"\\-_=+*#.:;,<>()\\[\\]{}!?]+$`, "gu");

function pairs(table: string): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < table.length; i += 2) map.set(table[i] as string, table[i + 1] as string);
  return map;
}

/**
 * A display name, cleaned like any text and then read through the fonts
 * people use to stand out: small caps, negative circled and squared letters,
 * Cyrillic or Greek look-alikes inside a Latin word, strikethrough and
 * underline overlays, decorative frames, and l e t t e r s spaced apart.
 * NFKC (in cleanText) already folds math alphabets, fullwidth, circled,
 * squared and superscript letters.
 */
export function cleanName(value: unknown, max: number = LIMITS.name): string {
  if (typeof value !== "string") return "";
  const text = cleanText(wellFormed(value).replace(DECORATION_MARKS, ""), max * 2);
  let words = [...text]
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      // Negative circled (U+1F150) and negative squared (U+1F170) capitals A to Z.
      if (code >= 0x1f150 && code <= 0x1f169) return String.fromCharCode(65 + code - 0x1f150);
      if (code >= 0x1f170 && code <= 0x1f189) return String.fromCharCode(65 + code - 0x1f170);
      return SMALL_CAPS.get(ch) ?? ch;
    })
    .join("")
    .split(" ")
    .map((word) => (/[A-Za-z]/.test(word) ? word.replace(CONFUSABLE, (ch) => CONFUSABLES.get(ch) ?? ch) : word));
  // "M A R I A": four or more single letters and nothing else are one word.
  if (words.length >= 4 && words.every((word) => /^\p{L}$/u.test(word))) words = [words.join("")];
  const name = words.join(" ");
  const unframed = name.replace(FRAME_EDGES, "");
  // A name that is nothing but frame stays as it is: it's still what people see.
  return clip((/[\p{L}\p{N}]/u.test(unframed) ? unframed : name).trim(), max);
}

/** An id is a key, not text to read: keep it as sent, minus what can't be stored or sent. */
function cleanId(value: unknown): string {
  if (typeof value !== "string") return "";
  return clip(wellFormed(value).replace(CONTROLS, "").replace(INVISIBLE, "").trim(), LIMITS.id);
}

/** A whole number within [min, max]; anything else (NaN, Infinity, negative, a string) becomes `fallback`. */
function int(value: unknown, min: number, max: number, fallback = min): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export function sanitizeViewer(viewer: Viewer | undefined): Viewer | undefined {
  if (!viewer || typeof viewer !== "object") return undefined;
  const handle = cleanText(typeof viewer.handle === "string" ? viewer.handle.replace(/^[@\s]+/, "") : "", LIMITS.name).replace(/\s/g, "");
  const id = cleanId(viewer.id) || handle;
  if (!id) return undefined;
  const nickname = cleanName(viewer.nickname) || handle || id;
  return { id, handle: handle || id, nickname };
}

/** A clean copy of `event`, or undefined when nothing usable is left. */
export function sanitizeEvent(event: LiveEvent): LiveEvent | undefined {
  if (!event || typeof event !== "object") return undefined;
  const at = typeof event.at === "number" && Number.isFinite(event.at) && event.at > 0 ? event.at : Date.now();
  switch (event.kind) {
    case "chat":
    case "question": {
      const viewer = sanitizeViewer(event.viewer);
      const text = cleanText(event.text);
      return viewer && text ? { kind: event.kind, at, viewer, text } : undefined;
    }
    case "gift": {
      const viewer = sanitizeViewer(event.viewer);
      if (!viewer) return undefined;
      const count = int(event.count, 1, LIMITS.count, 1);
      const diamonds = int(event.diamonds, 0, count * LIMITS.diamondsPerGift, 0);
      return { kind: "gift", at, viewer, giftName: cleanText(event.giftName, LIMITS.name) || "gift", count, diamonds };
    }
    case "like": {
      const viewer = sanitizeViewer(event.viewer);
      if (!viewer) return undefined;
      const total = int(event.total, 0, LIMITS.likesTotal, 0);
      return { kind: "like", at, viewer, count: int(event.count, 1, LIMITS.count, 1), ...(total ? { total } : {}) };
    }
    case "follow":
    case "share":
    case "join": {
      const viewer = sanitizeViewer(event.viewer);
      return viewer ? { kind: event.kind, at, viewer } : undefined;
    }
    case "viewers":
      return { kind: "viewers", at, count: int(event.count, 0, LIMITS.viewers, 0) };
    case "stream_end":
      return { kind: "stream_end", at, reason: cleanText(event.reason, LIMITS.reason) || "stream ended" };
    case "inactivity_check": {
      const captchaRecordId = cleanText(event.captchaRecordId, LIMITS.id);
      if (!captchaRecordId) return undefined;
      return { kind: "inactivity_check", at, captchaRecordId, verifyDurationInSec: int(event.verifyDurationInSec, 1, LIMITS.verifySeconds, 60) };
    }
    default:
      return undefined;
  }
}

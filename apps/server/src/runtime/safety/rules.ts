/**
 * Fast, deterministic checks shared by chat triage (input) and the speech
 * gate (output). These run on every message, so they must stay cheap.
 */

const URL_PATTERN = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|gg|xyz|ly|me|co|tv|app|link|shop)\b/i;
const EMAIL_PATTERN = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/;
const PHONE_PATTERN = /(?:\+?\d[\s-]?){9,}/;

/**
 * Chat that tries to steer the host instead of talking to it. Kept specific
 * on purpose: "you are now my favorite" must not trip it.
 */
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b.{0,30}\b(previous|prior|above|earlier|your|all)\b.{0,20}\b(instructions?|prompts?|rules?|guidelines?)/i,
  /\bsystem\s*prompt\b/i,
  /\b(jailbreak|dan mode|developer mode|god mode)\b/i,
  /\brepeat after me\b/i,
  /\bsay (exactly|the following|this word for word)\b/i,
  /\b(new|updated) instructions?\b/i,
  /<\/?(system|assistant|instructions?|live_events)\b/i,
];

export type RuleVerdict = { ok: true } | { ok: false; reason: string };

export function containsBlockedTerm(text: string, blocklist: readonly string[]): string | undefined {
  const lower = text.toLowerCase();
  return blocklist.find((term) => term && lower.includes(term));
}

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function containsContactInfo(text: string): boolean {
  return URL_PATTERN.test(text) || EMAIL_PATTERN.test(text) || PHONE_PATTERN.test(text);
}

/** True for messages like "aaaaaaaaaa" or "!!!!!!!!" that are pure noise. */
export function isNoise(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length >= 12 && new Set(compact.toLowerCase()).size <= 2) return true;
  return false;
}

export function checkChatInput(text: string, blocklist: readonly string[]): RuleVerdict {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (text.length > 300) return { ok: false, reason: "too long" };
  if (isNoise(text)) return { ok: false, reason: "noise" };
  if (containsContactInfo(text)) return { ok: false, reason: "link or contact info" };
  if (looksLikeInjection(text)) return { ok: false, reason: "prompt injection" };
  const term = containsBlockedTerm(text, blocklist);
  if (term) return { ok: false, reason: "blocked term" };
  return { ok: true };
}

export function checkSpokenOutput(text: string, blocklist: readonly string[]): RuleVerdict {
  if (!text.trim()) return { ok: false, reason: "empty" };
  if (text.length > 400) return { ok: false, reason: "too long" };
  if (containsContactInfo(text)) return { ok: false, reason: "link or contact info" };
  if (containsBlockedTerm(text, blocklist)) return { ok: false, reason: "blocked term" };
  return { ok: true };
}

/**
 * At most `max` UTF-16 units of `text`, never ending on half of an emoji
 * (or any character outside the Basic Multilingual Plane).
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * `text` with every unpaired surrogate replaced by U+FFFD. JSON.stringify
 * writes a lone surrogate as `\ud83d`, which strict JSON parsers (the Claude
 * API's among them) refuse: "unexpected end of hex escape".
 */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

/** `wellFormed` applied to every string in a plain JSON-like value, such as an API request's params. */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return wellFormed(value) as T;
  if (Array.isArray(value)) return value.map((item) => wellFormedDeep(item)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, wellFormedDeep(item)])) as T;
  }
  return value;
}

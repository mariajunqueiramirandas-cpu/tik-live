/** Formatting helpers. Numbers use tabular figures in CSS; these handle words. */
const LOCALE = "pt-BR";
const compact = new Intl.NumberFormat(LOCALE, { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat(LOCALE);

export function count(n: number): string {
  return n >= 10_000 ? compact.format(n) : whole.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

/** 1:42:10 or 4:05 */
export function clock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** "2 h 14 min", "45 min", "menos de um minuto" */
export function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "menos de um minuto";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto", style: "short" });
/** "há 2 min", "há 3 h", "ontem" (ICU adds a period after some abbreviations). */
const relative = (value: number, unit: Intl.RelativeTimeFormatUnit) => rtf.format(value, unit).replace(/\.$/, "");

export function ago(iso: string | number, now = Date.now()): string {
  const then = typeof iso === "number" ? iso : Date.parse(iso);
  const diff = (then - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "agora mesmo";
  if (abs < 3600) return relative(Math.round(diff / 60), "minute");
  if (abs < 86_400) return relative(Math.round(diff / 3600), "hour");
  if (abs < 86_400 * 30) return relative(Math.round(diff / 86_400), "day");
  return new Date(then).toLocaleDateString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** "17/10/2026, 14:05" */
export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** "14:05" */
export function time(at: number | string): string {
  return new Date(at).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
}

/** "R$ 49,90" */
export function money(amount: number | null, currency: string): string {
  if (amount === null) return "";
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency }).format(amount);
}

/** AI costs are billed in dollars: "US$ 0,012". */
export function usd(amount: number): string {
  return new Intl.NumberFormat(LOCALE, { style: "currency", currency: "USD", maximumFractionDigits: amount < 1 ? 3 : 2 }).format(amount);
}

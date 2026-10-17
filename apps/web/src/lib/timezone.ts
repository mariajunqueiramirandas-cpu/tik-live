import { isTimeZone } from "@tik-live/shared";

/** The browser's IANA time zone, if it reports a usable one. */
export function browserTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isTimeZone(zone) ? zone : undefined;
  } catch {
    return undefined;
  }
}

/** Used when the browser can't list its time zones. */
const FALLBACK_ZONES = [
  "UTC",
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Every time zone the browser knows, plus any extra (the saved one, the browser's own). */
export function timeZoneOptions(extra: Array<string | undefined>): string[] {
  let zones: string[];
  try {
    // Not in every lib.d.ts yet; present in all current browsers.
    const list = (Intl as { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone");
    zones = list && list.length > 0 ? list : FALLBACK_ZONES;
  } catch {
    zones = FALLBACK_ZONES;
  }
  const all = new Set(zones);
  for (const zone of extra) if (zone) all.add(zone);
  return [...all].sort((a, b) => a.localeCompare(b));
}

/** "America/Sao Paulo (GMT-3)" */
export function timeZoneLabel(zone: string, at = new Date()): string {
  const place = zone.replaceAll("_", " ");
  try {
    const offset = new Intl.DateTimeFormat("pt-BR", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
    return offset ? `${place} (${offset})` : place;
  } catch {
    return place;
  }
}

/** "14:05" in that zone. */
export function timeIn(zone: string, at = new Date()): string {
  try {
    return at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: zone });
  } catch {
    return "";
  }
}

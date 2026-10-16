import type { Look } from "@tik-live/shared";

/** The Lantern mark: a small glowing orb, the same character the stage draws. */
export function LanternMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="lantern-mark" cx="38%" cy="32%" r="72%">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.33" stopColor="#7CF5FF" />
          <stop offset="1" stopColor="#FF5FD2" />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill="url(#lantern-mark)" />
      <ellipse cx="11.6" cy="14.6" rx="1.7" ry="2.5" fill="#0B0420" />
      <ellipse cx="20.4" cy="14.6" rx="1.7" ry="2.5" fill="#0B0420" />
      <path d="M13 19.6q3 2.4 6 0" stroke="#0B0420" strokeWidth="1.7" fill="none" strokeLinecap="round" />
    </svg>
  );
}

/** A host's colors as a tiny orb (or waveform), so hosts are recognizable in lists. */
export function HostSwatch({ look, size = 28 }: { look: Look; size?: number }) {
  if (look.character === "voice-line") {
    return (
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
        <rect width="32" height="32" rx="9" fill={look.background} />
        <path d="M4 16c3 0 3-6 6-6s3 12 6 12 3-12 6-12 3 6 6 6" stroke={look.primary} strokeWidth="2" fill="none" strokeLinecap="round" />
        <path d="M4 16c3 0 3 4 6 4s3-8 6-8 3 8 6 8 3-4 6-4" stroke={look.secondary} strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.8" />
      </svg>
    );
  }
  const id = `swatch-${look.primary.slice(1)}-${look.secondary.slice(1)}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id={id} cx="38%" cy="32%" r="72%">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.3" stopColor={look.primary} />
          <stop offset="1" stopColor={look.secondary} />
        </radialGradient>
      </defs>
      <circle cx="16" cy="16" r="13" fill={`url(#${id})`} />
    </svg>
  );
}

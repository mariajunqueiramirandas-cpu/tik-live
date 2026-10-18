import type { PerksCard } from "@tik-live/shared";

/**
 * Gift powers (ADR-0039): a gift of so many diamonds unlocks something on
 * the show, right away and on screen. Each power includes the ones below
 * it: the "dono da live" also cuts the line and picks the next game.
 *
 * A viewer's gifts add up for a minute, so five roses sent one by one
 * unlock what one five-diamond gift would. Unlocking spends the credit.
 */
export const PERK_IDS = ["vip", "pick", "anthem", "boss"] as const;
export type PerkId = (typeof PERK_IDS)[number];

export interface Perk {
  id: PerkId;
  diamonds: number;
  /** As the alert and the host say it: "<name> desbloqueou Dono da live!". */
  label: string;
  /** Its row on the card. */
  card: string;
  /** What it does, for the host. */
  note: string;
}

export const PERKS: readonly Perk[] = [
  { id: "vip", diamonds: 5, label: "Fura-fila", card: "fura-fila no chat", note: "cuts the line: for the next few minutes, their messages are answered first" },
  { id: "pick", diamonds: 30, label: "Escolha do jogo", card: "escolhe o próximo jogo", note: "picks the next minigame, and cuts the line" },
  { id: "anthem", diamonds: 99, label: "Hino pessoal", card: "ganha um hino da IA", note: "gets a personal anthem from you, picks the next minigame, and cuts the line" },
  { id: "boss", diamonds: 199, label: "Dono da live", card: "dono da live por 5 min", note: "is the DONO DA LIVE for five minutes (a crown on screen, you treat them like royalty and do what they ask when it's safe), picks the next minigame, and cuts the line" },
];

/** Gifts from one viewer add up this long after their last one. */
export const CREDIT_MS = 60_000;
/** How long cutting the line lasts. */
export const VIP_MS = 3 * 60_000;
/** How long a "dono da live" reigns. */
export const BOSS_MS = 5 * 60_000;

export interface Boss {
  id: string;
  name: string;
  until: number;
}

export interface Unlock {
  perk: Perk;
  /** The "dono da live" this gift dethroned, if any. */
  dethroned?: Boss;
}

/** What a perk includes: the boss also gets the pick and the line, the anthem the pick and the line. */
export function includes(perk: PerkId, what: PerkId): boolean {
  if (perk === what) return true;
  if (what === "vip") return true;
  if (what === "pick") return perk !== "vip";
  return false;
}

export class GiftPerks {
  private readonly credit = new Map<string, { diamonds: number; at: number }>();
  private readonly vips = new Map<string, number>();
  private current: Boss | null = null;

  /**
   * A gift came in: adds to the viewer's credit and unlocks the biggest
   * power it now reaches, if any. A new "dono da live" takes the crown from
   * the one before.
   */
  gift(viewerId: string, name: string, diamonds: number, now: number): Unlock | null {
    const last = this.credit.get(viewerId);
    const credit = (last && now - last.at < CREDIT_MS ? last.diamonds : 0) + diamonds;
    const perk = [...PERKS].reverse().find((p) => credit >= p.diamonds);
    if (!perk) {
      this.credit.set(viewerId, { diamonds: credit, at: now });
      this.trim();
      return null;
    }
    this.credit.set(viewerId, { diamonds: credit - perk.diamonds, at: now });
    this.vips.set(viewerId, Math.max(this.vips.get(viewerId) ?? 0, now + (perk.id === "boss" ? BOSS_MS : VIP_MS)));
    let dethroned: Boss | undefined;
    if (perk.id === "boss") {
      const before = this.boss(now);
      if (before && before.id !== viewerId) dethroned = before;
      // The same boss again: the reign starts over from now.
      this.current = { id: viewerId, name, until: now + BOSS_MS };
    }
    this.trim();
    return dethroned ? { perk, dethroned } : { perk };
  }

  /** The "dono da live" now, if anyone. */
  boss(now: number): Boss | null {
    if (this.current && this.current.until <= now) this.current = null;
    return this.current;
  }

  /** How this viewer's messages rank: the boss first, then whoever cut the line. */
  rank(viewerId: string, now: number): "boss" | "vip" | undefined {
    if (this.boss(now)?.id === viewerId) return "boss";
    const until = this.vips.get(viewerId);
    if (until === undefined) return undefined;
    if (until <= now) {
      this.vips.delete(viewerId);
      return undefined;
    }
    return "vip";
  }

  /** The stream ended (or the creator reset it): every power goes. */
  clear(): void {
    this.credit.clear();
    this.vips.clear();
    this.current = null;
  }

  private trim(): void {
    if (this.credit.size > 5_000) this.credit.delete(this.credit.keys().next().value as string);
    if (this.vips.size > 5_000) this.vips.delete(this.vips.keys().next().value as string);
  }
}

/** The card the stage shows: what each gift unlocks. */
export function perksCard(): PerksCard {
  return { title: "PODERES DO PRESENTE", rows: PERKS.map((perk) => ({ diamonds: perk.diamonds, text: perk.card })) };
}

/** The powers on offer, in a line the host can say. */
export function perksSummary(): string {
  return PERKS.map((perk) => `${perk.diamonds} diamonds: ${perk.label} (${perk.card})`).join("; ");
}

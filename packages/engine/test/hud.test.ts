import { describe, expect, it } from "bun:test";
import type { Challenge } from "@tik-live/shared";
import { alertDetail } from "../src/engine";
import { challengeFraction, challengeHeadline, formatClock, pickHeader } from "../src/text/hud";
import { alertVerb, fitAlert } from "../src/text/sprites";

const likes: Challenge = { kind: "likes", title: "DESAFIO DAS CURTIDAS", detail: "toque na tela", value: 640, target: 1_000, remainingMs: 30_000, durationMs: 45_000, result: null, winner: null };
const raffle: Challenge = { kind: "raffle", title: "SORTEIO RELÂMPAGO", detail: "digite EU", value: 1, target: 0, remainingMs: 20_000, durationMs: 25_000, result: null, winner: null };

describe("gift powers, the dono da live and challenges (ADR-0039, ADR-0040)", () => {
  it("counts down in minutes and seconds, never 'já já'", () => {
    expect(formatClock(299.2)).toBe("5:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(7)).toBe("0:07");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(-3)).toBe("0:00");
  });

  it("fills a challenge's bar to its target, full once won, and never for a raffle", () => {
    expect(challengeFraction(likes)).toBeCloseTo(0.64);
    expect(challengeFraction({ ...likes, value: 1_500 })).toBe(1);
    expect(challengeFraction({ ...likes, value: 980, result: "won" })).toBe(1);
    expect(challengeFraction({ ...likes, result: "lost" })).toBeCloseTo(0.64);
    expect(challengeFraction({ ...likes, target: 0 })).toBe(0);
    expect(challengeFraction({ ...raffle, value: 40 })).toBe(0);
  });

  it("says how a challenge is going, and how it ended", () => {
    expect(challengeHeadline(likes)).toEqual({ title: "DESAFIO DAS CURTIDAS", line: "640 / 1.000" });
    expect(challengeHeadline({ ...likes, value: 12_400, target: 10_000, result: "won" })).toEqual({ title: "CONSEGUIMOS!", line: "12,4 mil / 10 mil" });
    expect(challengeHeadline({ ...likes, result: "lost" }).title).toBe("QUASE!");
    expect(challengeHeadline(raffle)).toEqual({ title: "SORTEIO RELÂMPAGO", line: "1 participante" });
    expect(challengeHeadline({ ...raffle, value: 41, result: "won", winner: "lu.desenha" })).toEqual({ title: "GANHOU: lu.desenha", line: "41 participantes" });
    expect(challengeHeadline({ ...raffle, value: 0, result: "lost" }).title).toBe("NINGUÉM PARTICIPOU");
  });

  it("names who chooses on a one-viewer pick", () => {
    expect(pickHeader("mari.souza")).toBe("ESCOLHA DE MARI.SOUZA");
  });

  it("words the new alerts", () => {
    expect(alertDetail({ t: "alert", kind: "crown", name: "caio" })).toBe("assumiu o topo dos presentes!");
    expect(alertDetail({ t: "alert", kind: "perk", name: "duda", perk: "Dono da live" })).toBe("Dono da live!");
    expect(alertDetail({ t: "alert", kind: "perk", name: "duda" })).toBe("um poder!");
    expect(alertDetail({ t: "alert", kind: "raffle", name: "lu" })).toBe("ganhou o sorteio!");
    expect(alertVerb("gift")).toBe(" enviou ");
    expect(alertVerb("perk")).toBe(" desbloqueou ");
    expect(alertVerb("crown")).toBe(" ");
  });

  it("shrinks a long alert before cutting the name, so it never reaches the HUD column", () => {
    // A fake font: every character is half the size wide.
    const measure = (text: string, size: number) => text.length * size * 0.5;
    const short = fitAlert(["duda", " ", "ganhou o sorteio!"], 600, measure);
    expect(short).toEqual({ size: 32, name: "duda" });
    const long = fitAlert(["a_very_long_viewer_name_x", " ", "assumiu o topo dos presentes!"], 600, measure);
    expect(long.size).toBeLessThan(32);
    expect(long.size).toBeGreaterThanOrEqual(24);
    const width = measure(long.name, long.size) + measure(" ", long.size) + measure("assumiu o topo dos presentes!", long.size) + 32;
    expect(width).toBeLessThanOrEqual(600);
    expect(long.name.endsWith("…")).toBe(true);
  });
});

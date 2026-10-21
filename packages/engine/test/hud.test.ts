import { describe, expect, it } from "bun:test";
import type { Challenge } from "@tik-live/shared";
import { alertDetail } from "../src/engine";
import { alertVerb, nextLabel, nextMood, toastLine, toastSlots, voteTab } from "../src/text/hud";
import { crownTarget, formatClock, goalLeft, goalNear, goalPercent, pickHeader, ringFraction, wrapLines } from "../src/text/kit";
import { challengeBarText, challengeFraction, challengeHeadline, tileReveal } from "../src/text/spotlight";

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

  it("says what's left on a running challenge's bar, and only the count once it's over", () => {
    expect(challengeBarText(likes)).toBe("640 / 1.000 · FALTAM 360");
    expect(challengeBarText({ ...likes, value: 999 })).toBe("999 / 1.000 · FALTA 1");
    expect(challengeBarText({ ...likes, value: 1_000 })).toBe("1.000 / 1.000");
    expect(challengeBarText({ ...likes, result: "lost" })).toBe("640 / 1.000");
    expect(challengeBarText(raffle)).toBe("1 participante");
  });

  it("names who chooses on a one-viewer pick", () => {
    expect(pickHeader("mari.souza")).toBe("ESCOLHA DE MARI.SOUZA");
  });

  it("pops the gift showcase's tiles in one after another", () => {
    expect(tileReveal(0, 0)).toBe(0);
    expect(tileReveal(0.3, 0)).toBe(1);
    expect(tileReveal(0.3, 1)).toBeCloseTo(0.6);
    expect(tileReveal(0.1, 2)).toBe(0);
    expect(tileReveal(0.66, 3)).toBe(1);
  });

  it("words the alerts as name cards: the name, then what they did", () => {
    expect(alertDetail({ t: "alert", kind: "crown", name: "caio" })).toBe("assumiu a coroa!");
    expect(alertDetail({ t: "alert", kind: "perk", name: "duda", perk: "Dono da live" })).toBe("Dono da live!");
    expect(alertDetail({ t: "alert", kind: "perk", name: "duda" })).toBe("um poder!");
    expect(alertDetail({ t: "alert", kind: "raffle", name: "lu" })).toBe("ganhou o sorteio!");
    expect(alertVerb("gift")).toBe(" enviou ");
    expect(alertVerb("perk")).toBe(" ativou ");
    expect(alertVerb("crown")).toBe(" ");
    expect(toastLine("gift", "Rose ×5")).toBe("enviou Rose ×5");
    expect(toastLine("perk", "Dono da live!")).toBe("ativou Dono da live!");
    expect(toastLine("follow", "começou a seguir")).toBe("começou a seguir");
  });

  it("stacks as many name cards as fit, from one to three", () => {
    expect(toastSlots(606, 888)).toBe(3);
    expect(toastSlots(412, 556)).toBe(1);
    expect(toastSlots(500, 560)).toBe(1);
    expect(toastSlots(200, 1800)).toBe(3);
  });
});

describe("the HUD's hooks (ADR-0049)", () => {
  it("says what's left for a goal, and when it's close", () => {
    expect(goalLeft({ value: 3_240, target: 5_000 })).toBe("FALTAM 1.760");
    expect(goalLeft({ value: 4_999, target: 5_000 })).toBe("FALTA 1");
    expect(goalLeft({ value: 10_000, target: 60_000 })).toBe("FALTAM 50 mil");
    expect(goalLeft({ value: 6_000, target: 5_000 })).toBe("FALTAM 0");
    expect(goalNear({ value: 3_999, target: 5_000 })).toBe(false);
    expect(goalNear({ value: 4_000, target: 5_000 })).toBe(true);
    expect(goalNear({ value: 5_000, target: 5_000 })).toBe(false);
    expect(goalPercent({ value: 4_995, target: 5_000 })).toBe("99%");
    expect(goalPercent({ value: 3_240, target: 5_000 })).toBe("64%");
  });

  it("drains the up-next ring and gets more urgent as it comes", () => {
    expect(ringFraction(150, 150)).toBe(1);
    expect(ringFraction(75, 150)).toBe(0.5);
    expect(ringFraction(-2, 150)).toBe(0);
    expect(ringFraction(10, 0)).toBe(0);
    expect(nextMood(154)).toBe("calm");
    expect(nextMood(60)).toBe("soon");
    expect(nextMood(9.5)).toBe("final");
    expect(nextMood(0)).toBe("due");
    expect(nextLabel("game", false)).toBe("PRÓXIMO JOGO");
    expect(nextLabel("segment", false)).toBe("A SEGUIR");
    expect(nextLabel("podium", false)).toBe("PÓDIO DA RODADA");
    expect(nextLabel("game", true)).toBe("COMEÇA JÁ JÁ");
  });

  it("puts what to type on the vote's tab, and what takes the crown under the gifters", () => {
    expect(voteTab(3)).toBe("VOTE: DIGITE 1 A 3");
    expect(voteTab(2)).toBe("VOTE: DIGITE 1 OU 2");
    expect(crownTarget(25_300)).toBe("25,3 mil+");
    expect(crownTarget(99)).toBe("99+");
  });

  it("wraps a line into rows that fit, cutting only the last one", () => {
    // A fake font: every character is 10 px wide.
    const measure = (text: string) => text.length * 10;
    expect(wrapLines("Presentes pagam as contas da IA", 200, 2, measure)).toEqual(["Presentes pagam as", "contas da IA"]);
    expect(wrapLines("Curta a live", 200, 2, measure)).toEqual(["Curta a live"]);
    const cut = wrapLines("Siga pra não perder a próxima live de hoje à noite", 200, 2, measure);
    expect(cut).toHaveLength(2);
    expect(cut[1]!.endsWith("…")).toBe(true);
    expect(measure(cut[1]!)).toBeLessThanOrEqual(200);
    // A single word too long for the row is cut, not dropped.
    expect(wrapLines("PARALELEPÍPEDOOOOOOOOOOOO", 100, 1, measure)[0]!.endsWith("…")).toBe(true);
  });
});

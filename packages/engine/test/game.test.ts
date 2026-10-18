import { describe, expect, it } from "bun:test";
import { EFFECTS, GAME_KINDS, type GameScene } from "@tik-live/shared";
import {
  deadlineFor,
  easeOutBack,
  countOf,
  ellipsize,
  fitText,
  formatCount,
  formatSeconds,
  leader,
  letterList,
  PALETTES,
  percentages,
  sceneChange,
  secondsLeft,
  shares,
  staticKey,
  tileGrid,
  timerFraction,
  trackPosition,
} from "../src/game/model";
import { alertDetail } from "../src/engine";
import { giftFlavor, giftTier, KIND, nextCombo } from "../src/stage/fx";

// Monospace stand-in: every character is 0.5em wide.
const measure = (size: number) => (text: string) => text.length * size * 0.5;

const trivia = (over: Partial<Extract<GameScene, { kind: "trivia" }>> = {}): GameScene => ({
  kind: "trivia",
  round: 1,
  rounds: 5,
  phase: "open",
  remainingMs: 20_000,
  durationMs: 30_000,
  question: "Qual é o maior planeta do sistema solar?",
  options: ["Saturno", "Júpiter", "Netuno", "Terra"],
  answers: 0,
  tally: null,
  correct: null,
  winners: [],
  ...over,
});

describe("scene transitions", () => {
  it("updates the same round in place and transitions to a new one", () => {
    expect(sceneChange(null, trivia())).toBe("enter");
    expect(sceneChange(trivia(), trivia({ answers: 12, remainingMs: 15_000 }))).toBe("update");
    expect(sceneChange(trivia(), trivia({ phase: "reveal", tally: [1, 2, 3, 4], correct: 1 }))).toBe("update");
    expect(sceneChange(trivia(), trivia({ round: 2 }))).toBe("swap");
    expect(sceneChange(trivia(), trivia({ question: "Outra pergunta?" }))).toBe("swap");
    expect(sceneChange(trivia(), { kind: "scoreboard", title: "Placar", rows: [] })).toBe("swap");
    expect(sceneChange(trivia(), null)).toBe("exit");
    expect(sceneChange(null, null)).toBe("none");
  });

  it("repaints the board only when static content changes", () => {
    expect(staticKey(trivia({ answers: 3, remainingMs: 1 }))).toBe(staticKey(trivia({ answers: 40 })));
    expect(staticKey(trivia())).not.toBe(staticKey(trivia({ phase: "reveal" })));
    const poll = (tally: number[]): GameScene => ({ kind: "poll", round: 1, rounds: 3, phase: "open", remainingMs: 5000, durationMs: 9000, question: "A ou B?", options: ["A", "B"], tally });
    // Live tallies move bars and labels, not the board.
    expect(staticKey(poll([1, 2]))).toBe(staticKey(poll([30, 2])));
  });

  it("has a palette for every scene kind", () => {
    for (const kind of [...GAME_KINDS, "scoreboard" as const, "podium" as const]) {
      const palette = PALETTES[kind];
      for (const color of Object.values(palette)) expect(color).toMatch(/^#[0-9A-F]{6}$/i);
    }
    const accents = new Set(Object.values(PALETTES).map((p) => p.background));
    expect(accents.size).toBe(GAME_KINDS.length + 2);
  });

  it("reveals podium places in place, repainting for each one", () => {
    const podium = (places: Array<{ name: string; points: number } | null>, suspense: number | null): GameScene => ({ kind: "podium", title: "Pódio geral", places, suspense });
    const hidden = podium([null, null, null], 3);
    const third = podium([null, null, { name: "duda", points: 20 }], null);
    expect(sceneChange(null, hidden)).toBe("enter");
    expect(sceneChange(hidden, third)).toBe("update");
    expect(sceneChange(third, podium([null, null, { name: "duda", points: 20 }], 2))).toBe("update");
    expect(staticKey(hidden)).not.toBe(staticKey(third));
    expect(staticKey(third)).not.toBe(staticKey(podium([null, null, { name: "duda", points: 20 }], 2)));
    expect(sceneChange(third, null)).toBe("exit");
  });
});

describe("countdown", () => {
  it("sets a local deadline on receipt and ignores jitter in re-sends", () => {
    const deadline = deadlineFor(null, 10, 20_000);
    expect(deadline).toBe(30);
    // 4 s later the server says 15.8 s left: within jitter, keep the deadline.
    expect(deadlineFor(deadline, 14, 15_800)).toBe(30);
    // The round was extended: take the new one.
    expect(deadlineFor(deadline, 14, 26_000)).toBe(40);
  });

  it("draws the bar from the deadline and rounds seconds up", () => {
    expect(timerFraction(10, 30, 30_000)).toBeCloseTo(2 / 3);
    expect(timerFraction(40, 30, 30_000)).toBe(0);
    expect(timerFraction(0, 30, 0)).toBe(0);
    expect(secondsLeft(29.2, 30)).toBe(1);
    expect(secondsLeft(30, 30)).toBe(0);
    expect(secondsLeft(10, 30)).toBe(20);
  });
});

describe("votes", () => {
  it("rounds percentages to exactly 100", () => {
    expect(percentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentages([42, 58])).toEqual([42, 58]);
    expect(percentages([0, 0])).toEqual([0, 0]);
    expect(percentages([2, 1, 1, 3]).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("gives bar lengths and the leader", () => {
    expect(shares([1, 3])).toEqual([0.25, 0.75]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(leader([3, 9, 9])).toBe(1);
    expect(leader([0, 0])).toBe(-1);
  });

  it("places numbers on the track", () => {
    expect(trackPosition(50, 0, 100)).toBe(0.5);
    expect(trackPosition(-5, 0, 100)).toBe(0);
    expect(trackPosition(7, 7, 7)).toBe(0.5);
  });
});

describe("text fitting", () => {
  it("keeps the biggest size that fits", () => {
    const fit = fitText("Qual é o maior planeta?", 900, 3, [62, 56, 52], measure);
    expect(fit.size).toBe(62);
    expect(fit.lines).toEqual(["Qual é o maior planeta?"]);
  });

  it("shrinks a long single word instead of cutting it", () => {
    const fit = fitText("PARALELEPÍPEDO", 600, 1, [190, 150, 100, 80], measure);
    expect(fit.size).toBe(80);
    expect(fit.lines).toEqual(["PARALELEPÍPEDO"]);
  });

  it("wraps, then ellipsizes past the line limit, never wider than the box", () => {
    const text = "Júpiter, o gigante gasoso com a Grande Mancha Vermelha e dezenas de luas";
    const fit = fitText(text, 400, 2, [44, 40], measure);
    expect(fit.size).toBe(40);
    expect(fit.lines).toHaveLength(2);
    expect(fit.lines[1]?.endsWith("…")).toBe(true);
    for (const width of fit.widths) expect(width).toBeLessThanOrEqual(400);
  });

  it("ellipsizes a word too long for any size", () => {
    const fit = fitText("Supercalifragilisticexpialidocious", 200, 1, [40], measure);
    expect(fit.lines[0]?.endsWith("…")).toBe(true);
    expect(fit.widths[0]).toBeLessThanOrEqual(200);
    expect(ellipsize("short", 200, measure(40))).toBe("short");
  });
});

describe("letter tiles", () => {
  it("uses one row up to nine letters, then balanced rows", () => {
    expect(tileGrid(7, 872, 132)).toEqual({ perRow: 7, rows: 1, size: 112, gap: 14 });
    const long = tileGrid(24, 872, 132);
    expect(long.rows).toBe(3);
    expect(long.perRow).toBe(8);
    expect(long.perRow * long.size + (long.perRow - 1) * long.gap).toBeLessThanOrEqual(872);
    expect(tileGrid(3, 872, 132).size).toBe(132);
  });
});

describe("animation helpers", () => {
  it("overshoots a little and settles at 1", () => {
    expect(easeOutBack(0)).toBeCloseTo(0);
    expect(easeOutBack(1)).toBeCloseTo(1);
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => easeOutBack(i / 49)))).toBeGreaterThan(1.05);
  });
});

describe("pt-BR board text", () => {
  it("writes seconds with a decimal comma", () => {
    expect(formatSeconds(1420)).toBe("1,4 s");
    expect(formatSeconds(900)).toBe("0,9 s");
    expect(formatSeconds(75_000)).toBe("75 s");
  });

  it("groups thousands with a dot", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(999)).toBe("999");
    expect(formatCount(1234)).toBe("1.234");
    expect(formatCount(1_000_000)).toBe("1.000.000");
    expect(formatCount(-4200)).toBe("-4.200");
  });

  it("counts in the singular only for one", () => {
    expect(countOf(1, "resposta")).toBe("1 resposta");
    expect(countOf(12, "resposta")).toBe("12 respostas");
    expect(countOf(0, "palpite")).toBe("0 palpites");
    expect(countOf(1, "voto")).toBe("1 voto");
    expect(countOf(1500, "voto")).toBe("1.500 votos");
  });

  it("lists the letters to type with 'ou'", () => {
    expect(letterList(["A", "B"])).toBe("A ou B");
    expect(letterList(["A", "B", "C"])).toBe("A, B ou C");
    expect(letterList(["A", "B", "C", "D"])).toBe("A, B, C ou D");
    expect(letterList(["A"])).toBe("A");
  });

  it("words alerts in Portuguese, keeping TikTok's gift names", () => {
    expect(alertDetail({ t: "alert", kind: "gift", name: "duda", giftName: "Galaxy", count: 1, diamonds: 1000 })).toBe("Galaxy");
    expect(alertDetail({ t: "alert", kind: "gift", name: "duda", giftName: "Rose", count: 5, diamonds: 5 })).toBe("Rose ×5");
    expect(alertDetail({ t: "alert", kind: "gift", name: "duda", count: 1, diamonds: 1 })).toBe("um presente");
    expect(alertDetail({ t: "alert", kind: "follow", name: "lu" })).toBe("começou a seguir");
    expect(alertDetail({ t: "alert", kind: "share", name: "lu" })).toBe("compartilhou a live");
  });
});

describe("gift effects", () => {
  it("tiers gifts by diamonds", () => {
    expect([1, 9, 10, 99, 100, 999, 1000, 44_999].map(giftTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it("gives roses and space gifts their own flavor", () => {
    expect(giftFlavor("Rose")).toBe("love");
    expect(giftFlavor("Heart Me")).toBe("love");
    expect(giftFlavor("Galaxy")).toBe("space");
    expect(giftFlavor("TikTok Universe")).toBe("space");
    expect(giftFlavor("Doughnut")).toBeNull();
  });

  it("knows a particle kind for every particle effect", () => {
    expect(EFFECTS.length).toBe(12);
    expect(Object.keys(KIND)).toEqual(["dot", "confetti", "heart", "star", "sparkle", "note", "bubble", "streak", "petal"]);
  });
});

describe("gift combos", () => {
  it("grows while gifts keep coming and starts over after a pause", () => {
    let count = 0;
    let at = -Infinity;
    for (const t of [0, 2, 4, 8.5, 9]) {
      count = nextCombo(count, at, t);
      at = t;
    }
    // 0, 2, 4 are a run of three; 8.5 is 4.5 s later (still on), 9 makes five.
    expect(count).toBe(5);
    expect(nextCombo(5, 9, 14.5)).toBe(1);
  });
});

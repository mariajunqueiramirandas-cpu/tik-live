import { describe, expect, it } from "bun:test";
import { tickerSchema } from "@tik-live/shared";
import { PERKS } from "../../src/runtime/perks";
import { supportTicker } from "../../src/runtime/ticker";

describe("the support ticker (ADR-0041)", () => {
  it("leads with the bills, lists every gift power with its price, and fits the stage message", () => {
    const ticker = supportTicker({ perks: true, asks: "light" });
    expect(tickerSchema.parse(ticker)).toEqual(ticker);
    expect(ticker.lines[0]).toEqual({ way: "gift", text: "Presentes pagam as contas da IA" });
    expect(ticker.lines.filter((line) => line.diamonds)).toEqual(PERKS.map((perk) => ({ way: "gift", text: perk.card, diamonds: perk.diamonds })));
    expect(ticker.lines.map((line) => line.way).filter((way) => way !== "gift")).toEqual(["like", "follow", "share"]);
  });

  it("puts a free way to help after every gift line in light mode, every two when the channel asks actively", () => {
    const light = supportTicker({ perks: false, asks: "light" }).lines.map((line) => line.way);
    expect(light.slice(0, 6)).toEqual(["gift", "like", "gift", "follow", "gift", "share"]);
    const active = supportTicker({ perks: false, asks: "active" }).lines.map((line) => line.way);
    expect(active.slice(0, 6)).toEqual(["gift", "gift", "like", "gift", "gift", "follow"]);
    expect(supportTicker({ perks: false, asks: "light" }).lines.some((line) => line.diamonds)).toBe(false);
  });
});

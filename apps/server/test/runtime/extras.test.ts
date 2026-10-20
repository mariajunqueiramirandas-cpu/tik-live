import { describe, expect, it } from "bun:test";
import type { Challenge, LiveEvent, PerksCard, Persona, Ticker } from "@tik-live/shared";
import { Director, type StageNotifier } from "../../src/runtime/brain/director";
import type { HostBrain } from "../../src/runtime/brain/host";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import { buildSystemPrompt, type TurnRequest } from "../../src/runtime/brain/prompt";
import type { Utterance } from "../../src/runtime/brain/sentences";
import { isQuestion, Triage } from "../../src/runtime/brain/triage";
import { niceTarget, RoomChallenge, saysWord } from "../../src/runtime/challenges";
import { GameMaster } from "../../src/runtime/games/master";
import { pickOptions, SoloPick } from "../../src/runtime/games/vote";
import { BOSS_MS, CREDIT_MS, GiftPerks, PERKS } from "../../src/runtime/perks";
import { moderationPolicy, SafetyGate } from "../../src/runtime/safety/gate";
import { SpeechPipeline, type SpeechOutput } from "../../src/runtime/voice/pipeline";
import { NoTts } from "../../src/runtime/voice/tts";
import { chat, fakeClock, gift, persona, viewer } from "./helpers";

class FakeHost implements HostBrain {
  readonly name = "fake";
  turns: TurnRequest[] = [];
  async *generate(turn: TurnRequest): AsyncGenerator<Utterance> {
    this.turns.push(turn);
    yield { text: `line for ${turn.kind} ${this.turns.length}`, emotion: "neutral" };
  }
  reconfigure(): void {}
}

const instantOutput: SpeechOutput = { play: async () => {}, interrupt: () => {} };

/** A director with games, gift powers and (optionally) challenges, recording what the stage got. */
function setup(options: { persona?: Partial<Persona>; random?: () => number; giftPerks?: boolean } = {}) {
  const clock = fakeClock();
  const memory = new ViewerMemory({ now: clock.now });
  const triage = new Triage({ blocklist: [], hostName: persona.name, memory, now: clock.now });
  const speech = new SpeechPipeline(new NoTts(), new SafetyGate({ blocklist: [] }), instantOutput, {}, clock.now);
  const host = new FakeHost();
  const got = {
    votes: [] as Array<{ title: string; options: string[]; tally: number[]; by?: string } | null>,
    perks: [] as Array<PerksCard | null>,
    tickers: [] as Array<Ticker | null>,
    boss: [] as Array<{ name: string; leftMs: number } | null>,
    crowns: [] as string[],
    unlocks: [] as Array<[string, string]>,
    challenges: [] as Array<Challenge | null>,
    raffles: [] as string[],
  };
  const stage: StageNotifier = {
    alert: () => {},
    segment: () => {},
    stats: () => {},
    fx: () => {},
    sfx: () => {},
    vote: (vote) => got.votes.push(vote),
    perks: (card) => got.perks.push(card),
    ticker: (ticker) => got.tickers.push(ticker),
    boss: (boss) => got.boss.push(boss),
    crown: (name) => got.crowns.push(name),
    perk: (name, perk) => got.unlocks.push([name, perk]),
    challenge: (challenge) => got.challenges.push(challenge),
    raffleWinner: (name) => got.raffles.push(name),
  };
  const games = new GameMaster({
    writer: null,
    gate: { check: async () => ({ safe: true }) },
    stage: { game: () => {}, fx: () => {}, sfx: () => {} },
    blocklist: () => [],
    language: () => "pt-BR",
    sounds: () => false,
    now: clock.now,
  });
  const director = new Director({
    persona: { ...persona, segments: [{ id: "a", title: "Resenha", minutes: 60, prompt: "Converse." }], ...options.persona },
    host,
    triage,
    memory,
    speech,
    stage,
    games,
    deadAirMs: 600_000,
    random: options.random ?? (() => 0),
    giftPerks: () => options.giftPerks ?? true,
    now: clock.now,
  });
  director.handleEvent({ kind: "viewers", at: 0, count: 20 });
  const step = async (ms = 0) => {
    clock.advance(ms);
    await director.tick();
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { clock, director, host, triage, games, got, step };
}

function like(handle: string, count: number): LiveEvent {
  return { kind: "like", at: 0, viewer: viewer(handle), count };
}

describe("gift powers", () => {
  it("unlocks the biggest power a viewer's gifts reach, adding up gifts sent within a minute", () => {
    const perks = new GiftPerks();
    expect(perks.gift("ana", "ana", 1, 0)).toBeNull();
    expect(perks.gift("ana", "ana", 3, 1_000)).toBeNull();
    expect(perks.gift("ana", "ana", 1, 2_000)?.perk.id).toBe("vip"); // 1 + 3 + 1
    expect(perks.rank("ana", 2_000)).toBe("vip");
    // The credit was spent: the next 25 aren't a pick yet.
    expect(perks.gift("ana", "ana", 25, 3_000)?.perk.id).toBe("vip");
    expect(perks.gift("bia", "bia", 20, 0)?.perk.id).toBe("vip");
    expect(perks.gift("bia", "bia", 20, CREDIT_MS + 1)?.perk.id).toBe("vip"); // the first 20 expired
    expect(perks.gift("caio", "caio", 30, 0)?.perk.id).toBe("pick");
    expect(perks.gift("duda", "duda", 100, 0)?.perk.id).toBe("anthem");
    expect(PERKS.at(-1)?.id).toBe("boss");
  });

  it("crowns a dono da live, lets a bigger fan take the crown, and ends the reign on time", () => {
    const perks = new GiftPerks();
    expect(perks.gift("ana", "ana", 199, 0)?.perk.id).toBe("boss");
    expect(perks.boss(1_000)?.name).toBe("ana");
    expect(perks.rank("ana", 1_000)).toBe("boss");
    const coup = perks.gift("bia", "bia", 500, 2_000);
    expect(coup).toMatchObject({ perk: { id: "boss" }, dethroned: { name: "ana" } });
    expect(perks.boss(3_000)?.name).toBe("bia");
    expect(perks.rank("ana", 3_000)).toBe("vip"); // she still cuts the line for a while
    expect(perks.boss(2_000 + BOSS_MS)).toBeNull();
  });

  it("lets only the picker choose, from three games with a party game among them", () => {
    const options = pickOptions(() => 0.3);
    expect(new Set(options).size).toBe(3);
    expect(options.some((kind) => ["tug", "potato"].includes(kind))).toBe(true);
    const pick = new SoloPick("ana", "ana", ["tug", "trivia", "potato"], "gift");
    expect(pick.cast("bia", "1")).toBe(false);
    expect(pick.cast("ana", "oi")).toBe(false);
    expect(pick.cast("ana", "3")).toBe(true);
    expect(pick.choice).toBe("potato");
  });

  it("opens a pick for a 30-diamond gift: the card names the gifter and their choice is the next game", async () => {
    const { director, got, games, host, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Rosquinha", 30));
    expect(got.unlocks).toEqual([["ana", "Escolha do jogo"]]);
    await step(2_000);
    const card = got.votes.at(-1);
    expect(card?.by).toBe("ana");
    expect(card?.options).toHaveLength(3);
    // The host thanks the gift with the power and the options in the brief: one turn, not two.
    const thanks = host.turns.find((turn) => turn.context.brief.includes("unlocked Escolha do jogo"));
    expect(thanks?.context.brief).toContain(`1) ${card?.options[0]}`);
    expect(thanks?.context.brief).toContain("tell ana to type the number now");

    director.handleEvent(chat("bia", "2")); // not hers to choose: it's ordinary chat
    director.handleEvent(chat("ana", "2"));
    await step(500);
    expect(got.votes.at(-1)).toBeNull();
    await step(2_000);
    expect(host.turns.some((turn) => turn.note?.includes(`ana chose ${card?.options[1]}`))).toBe(true);
    await step(9_000);
    expect(games.status()?.source).toBe("pick");
  });

  it("draws for a picker who doesn't choose in time", async () => {
    const { director, games, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Rosquinha", 30));
    await step(31_000);
    await step(9_000);
    expect(games.isActive()).toBe(true);
  });

  it("crowns the dono da live on stage, answers them first, and gives them an anthem's worth of drama", async () => {
    const { director, got, host, triage, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Leão", 300));
    expect(got.boss.at(-1)).toMatchObject({ name: "ana", leftMs: BOSS_MS });
    expect(triage.rankOf("ana")).toBe("boss");
    director.handleEvent(chat("bia", "oi gente tudo bem"));
    director.handleEvent(chat("ana", "conta uma piada"));
    expect(triage.peek()[1]?.event).toMatchObject({ viewer: { handle: "ana" } }); // only her gift is ahead of her
    await step(2_000);
    const thanks = host.turns.find((turn) => turn.items.some((item) => item.event.kind === "gift"));
    expect(thanks?.context.brief).toContain("the dono da live");
    expect(thanks?.game).toContain("Dono da live: ana");
    await step(BOSS_MS);
    expect(got.boss.at(-1)).toBeNull();
  });

  it("takes the crown off a dethroned dono da live in the chat queue too", async () => {
    const { director, got, triage, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Leão", 300));
    director.handleEvent(gift("bia", "Leão", 300));
    expect(got.boss.at(-1)?.name).toBe("bia");
    expect(triage.rankOf("bia")).toBe("boss");
    expect(triage.rankOf("ana")).toBe("vip");
  });

  it("queues an anthem for a 99-diamond gift, after the open round", async () => {
    const { director, host, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Chapéu", 99));
    for (let i = 0; i < 8; i++) await step(2_000);
    expect(host.turns.some((turn) => turn.kind === "perk" && turn.note?.includes("ana unlocked a personal anthem"))).toBe(true);
  });

  it("calls out a new first place among the gifters", async () => {
    const { director, got, host, step } = setup();
    await step();
    director.handleEvent(gift("ana", "Rosa", 3));
    director.handleEvent(gift("bia", "Rosa", 4));
    expect(got.crowns).toEqual(["bia"]);
    await step(2_000);
    expect(host.turns.some((turn) => turn.context.brief.includes("took first place among the gifters from ana"))).toBe(true);
  });

  it("puts the card with the powers up now and then, and stays quiet about them when they're off", async () => {
    const on = setup();
    await on.step();
    await on.step(5 * 60_000);
    expect(on.got.perks[0]?.rows.map((row) => row.diamonds)).toEqual([5, 30, 99, 199]);
    expect(on.got.perks[0]?.every).toContain("seu nome na live");
    await on.step(20_000);
    expect(on.got.perks.at(-1)).toBeNull();

    const off = setup({ giftPerks: false });
    await off.step();
    off.director.handleEvent(gift("ana", "Leão", 300));
    await off.step(5 * 60_000);
    expect(off.got.perks).toEqual([]);
    expect(off.got.unlocks).toEqual([]);
    expect(off.got.boss).toEqual([]);
  });

  it("keeps the support ticker up from the start, with the powers and their prices, and takes it down when support is off", async () => {
    const on = setup();
    on.director.start(60_000_000);
    on.director.stop();
    await on.step(60_000);
    expect(on.got.tickers).toHaveLength(1); // sent once, not every tick
    const lines = on.got.tickers[0]?.lines ?? [];
    expect(lines[0]).toEqual({ way: "gift", text: "Presentes pagam as contas da IA" });
    expect(lines.filter((line) => line.diamonds).map((line) => line.diamonds)).toEqual([5, 30, 99, 199]);
    expect(lines.some((line) => line.way === "like")).toBe(true);

    const off = setup({ giftPerks: false });
    off.director.start(60_000_000);
    off.director.stop();
    expect(off.got.tickers[0]?.lines.some((line) => line.diamonds)).toBe(false);
    off.director.reconfigure({ ...persona, segments: [{ id: "a", title: "Resenha", minutes: 60, prompt: "Converse." }], support: false });
    await off.step();
    expect(off.got.tickers.at(-1)).toBeNull();
  });
});

describe("room challenges", () => {
  it("reads entries, rounds targets, and ends on the target or the clock", () => {
    expect(saysWord("EU", "EU")).toBe(true);
    expect(saysWord("euuu quero", "EU")).toBe(true);
    expect(saysWord("eu acho que não vou participar disso não", "EU")).toBe(false);
    expect(niceTarget(43)).toBe(50);
    expect(niceTarget(612)).toBe(650);
    expect(niceTarget(12_345)).toBe(15_000);

    const likes = new RoomChallenge();
    likes.start({ kind: "likes", target: 100, durationMs: 45_000, word: "" }, 0);
    likes.like(60);
    expect(likes.tick(1_000)).toBeNull();
    likes.like(50);
    expect(likes.tick(2_000)).toMatchObject({ result: "won", value: 110 });
    expect(likes.view(3_000)?.result).toBe("won");
    expect(likes.tick(2_000 + 6_000)).toBeNull();
    expect(likes.shown()).toBe(false);

    const rush = new RoomChallenge();
    rush.start({ kind: "chat", target: 3, durationMs: 30_000, word: "BORA" }, 0);
    expect(rush.chat("ana", "ana", "bora", 0)).toBe(true);
    expect(rush.chat("ana", "ana", "BORA", 500)).toBe(true); // taken, but too soon to count again
    expect(rush.chat("bia", "bia", "oi", 600)).toBe(false);
    expect(rush.view(600)?.value).toBe(1);
    expect(rush.tick(30_000)).toMatchObject({ result: "lost", value: 1 });
  });

  it("draws the raffle's winner from whoever entered", () => {
    const raffle = new RoomChallenge(() => 0.99);
    raffle.start({ kind: "raffle", target: 0, durationMs: 25_000, word: "EU" }, 0);
    raffle.chat("ana", "ana", "eu", 1_000);
    raffle.chat("bia", "bia", "EU!", 2_000);
    raffle.chat("ana", "ana", "eu", 3_000);
    expect(raffle.view(3_000)?.value).toBe(2);
    expect(raffle.tick(25_000)).toMatchObject({ result: "won", players: 2, winner: { name: "bia" } });
  });

  it("runs a like rush a few minutes in, celebrates the win with a prize, then a raffle whose winner picks a game", async () => {
    const { director, got, host, step } = setup({ persona: { challenges: true } });
    await step();
    await step(4 * 60_000);
    const rush = got.challenges.at(-1);
    expect(rush).toMatchObject({ kind: "likes", result: null });
    await step(2_000);
    expect(host.turns.some((turn) => turn.note?.includes("Like challenge, on screen now"))).toBe(true);
    director.handleEvent(like("ana", rush?.target ?? 0));
    await step(300);
    expect(got.challenges.at(-1)?.result).toBe("won");
    await step(2_000);
    expect(host.turns.some((turn) => turn.note?.includes("The room beat the like challenge") && turn.note.includes("as the prize"))).toBe(true);
    await step(7_000);
    expect(got.challenges.at(-1)).toBeNull();

    await step(6 * 60_000);
    expect(got.challenges.at(-1)).toMatchObject({ kind: "raffle" });
    director.handleEvent(chat("bia", "EU"));
    await step(26_000);
    expect(got.raffles).toEqual(["bia"]);
    await step(2_000);
    expect(got.votes.at(-1)?.by).toBe("bia");
  });

  it("keeps running challenges after the creator resets the stream's counters", async () => {
    const { director, got, step } = setup({ persona: { challenges: true } });
    await step();
    director.resetSession();
    await step(4 * 60_000);
    expect(got.challenges.at(-1)?.kind).toBe("likes");
  });

  it("waits for a game to finish before starting a challenge", async () => {
    const { director, games, got, step } = setup({ persona: { challenges: true } });
    await step();
    games.start({ kind: "tug", rounds: 1 }, "studio");
    await step(4 * 60_000);
    expect(got.challenges).toEqual([]);
    games.stop();
    await step(20_000);
    expect(got.challenges.at(-1)?.kind).toBe("likes");
    void director;
  });
});

describe("more questions, more opinions", () => {
  const q = (text: string) => isQuestion({ kind: "chat", at: 0, viewer: viewer("x"), text });

  it("hears Brazilian questions without a question mark", () => {
    expect(q("oq vc acha do neymar")).toBe(true);
    expect(q("qual seu time")).toBe(true);
    expect(q("me fala uma curiosidade")).toBe(true);
    expect(q("opina sobre pizza doce")).toBe(true);
    expect(q("você prefere praia ou campo")).toBe(true);
    expect(q("por que o céu é azul")).toBe(true);
    expect(q("vc é muito engraçada")).toBe(false);
    expect(q("boa noite gente")).toBe(false);
  });

  it("keeps a question-shaped message long enough to answer", () => {
    const clock = fakeClock();
    const triage = new Triage({ blocklist: [], hostName: "Blip", memory: new ViewerMemory({ now: clock.now }), now: clock.now });
    triage.ingest(chat("ana", "qual seu signo"));
    clock.advance(40_000);
    expect(triage.pending()).toBe(1);
  });

  it("gives the host opinions, and opens politics and religion only in sem-filtro mode", () => {
    const standard = buildSystemPrompt(persona, { strictness: "standard", avoidTopics: [] });
    expect(standard).toContain("# Opinions");
    expect(standard).toContain("Don't take sides between political parties");
    expect(standard).toContain("# Gift powers");
    const spicy = buildSystemPrompt(persona, { strictness: "spicy", avoidTopics: [] });
    expect(spicy).toContain("sem-filtro mode");
    expect(spicy).toContain("politics and religion included");
    expect(spicy).not.toContain("Don't take sides between political parties");
    expect(spicy).toContain("telling anyone who to vote for");
    const off = buildSystemPrompt(persona, { strictness: "standard", avoidTopics: [], giftPerks: false });
    expect(off).not.toContain("# Gift powers");
  });

  it("tells the moderator what sem-filtro mode and the gift powers allow", () => {
    const spicy = moderationPolicy({ strictness: "spicy", avoidTopics: [] });
    expect(spicy).toContain("SEM FILTRO");
    expect(spicy).toContain("hate or slurs against people for who they are");
    expect(spicy).toContain("199 diamonds: Dono da live");
    expect(moderationPolicy({ strictness: "standard", avoidTopics: [], giftPerks: false })).not.toContain("gift powers");
  });
});

describe("welcoming people who just arrived", () => {
  it("names first-time arrivals in the next quiet moment", async () => {
    const { director, host, step } = setup({ persona: { support: false } });
    await step();
    await step(590_000);
    director.handleEvent({ kind: "join", at: 0, viewer: viewer("lia") });
    director.handleEvent({ kind: "join", at: 0, viewer: viewer("rafa") });
    // Nothing else happening: the next quiet moment welcomes them, before the call to passers-by that's due.
    await step(15_000);
    expect(host.turns.at(-1)?.note).toContain("welcome lia, rafa by name");
  });
});

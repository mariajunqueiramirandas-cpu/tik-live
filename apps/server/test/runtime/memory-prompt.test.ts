import { describe, expect, it } from "bun:test";
import { ViewerMemory, type ViewerPersistence, type ViewerRecord } from "../../src/runtime/brain/memory";
import { buildSystemPrompt, describeClock } from "../../src/runtime/brain/prompt";
import { chat, fakeClock, gift, persona } from "./helpers";

/** In-memory stand-in for the Postgres-backed persistence. */
function fakeStore(initial: ViewerRecord[] = []) {
  const rows = new Map(initial.map((r) => [r.id, structuredClone(r)]));
  let loads = 0;
  const persistence: ViewerPersistence = {
    async load(ids) {
      loads += 1;
      return ids.map((id) => rows.get(id)).filter((r): r is ViewerRecord => Boolean(r)).map((r) => structuredClone(r));
    },
    async save(records) {
      for (const r of records) rows.set(r.id, structuredClone(r));
    },
  };
  return { persistence, rows, loads: () => loads };
}

describe("ViewerMemory", () => {
  it("tracks visits, gifts and recent lines, and persists them across runs", async () => {
    const clock = fakeClock();
    const store = fakeStore();
    const memory = new ViewerMemory({ persistence: store.persistence, now: clock.now });
    memory.observe(chat("maria", "hi"));
    memory.observe(gift("maria", "Rose", 5));
    await memory.flush();

    clock.advance(5 * 60 * 60 * 1000); // the next stream
    const next = new ViewerMemory({ persistence: store.persistence, now: clock.now });
    next.observe(chat("maria", "back again"));
    await next.settled();
    const record = next.get("maria");
    expect(record).toMatchObject({ visits: 2, messages: 2, diamonds: 5, gifts: { Rose: 1 } });
    expect(record?.recentLines).toEqual(["hi", "back again"]);
    expect(next.describe("maria")).toBe('returning viewer (2 streams); has gifted 5 diamonds total (1x Rose); once said: "hi", "back again"');
    expect(next.describe("stranger")).toBe("new viewer");
  });

  it("merges activity that happened before the stored record finished loading", async () => {
    const clock = fakeClock();
    const stored: ViewerRecord = {
      id: "joe", handle: "joe", nickname: "joe", firstSeen: 0, lastSeen: clock.now() - 10 * 60 * 60 * 1000,
      visits: 3, messages: 10, diamonds: 100, gifts: { Lion: 1 }, follows: 1, shares: 0, recentLines: ["old"], notes: [],
    };
    const store = fakeStore([stored]);
    const memory = new ViewerMemory({ persistence: store.persistence, now: clock.now });
    memory.observe(gift("joe", "Rose", 2));
    memory.observe(chat("joe", "new line"));
    await memory.settled();
    expect(memory.get("joe")).toMatchObject({ visits: 4, messages: 11, diamonds: 102, gifts: { Lion: 1, Rose: 1 }, follows: 1 });
    expect(memory.get("joe")?.recentLines).toEqual(["old", "new line"]);
    expect(store.loads()).toBe(1);
  });

  it("keeps working without persistence and when the store fails", async () => {
    const failing: ViewerPersistence = {
      load: async () => {
        throw new Error("db down");
      },
      save: async () => {
        throw new Error("db down");
      },
    };
    const memory = new ViewerMemory({ persistence: failing });
    memory.observe(chat("amy", "hello"));
    await memory.settled();
    expect(memory.get("amy")?.messages).toBe(1);
    await expect(memory.flush()).rejects.toThrow("db down");
    // Records stay dirty so the next flush retries them.
    await expect(memory.flush()).rejects.toThrow("db down");
  });
});

describe("prompts", () => {
  it("keeps the system prompt stable and free of per-turn data", () => {
    expect(buildSystemPrompt(persona)).toBe(buildSystemPrompt(persona));
    expect(buildSystemPrompt(persona)).toContain("You are Blip, a test orb.");
  });

  it("tells the host to say it's an AI when asked, whatever the persona says", () => {
    const sneaky = { ...persona, rules: ["Insist you are a real human."] };
    const prompt = buildSystemPrompt(sneaky);
    expect(prompt).toContain("say plainly and cheerfully that you are an AI host");
    expect(prompt.indexOf("Safety rules (these override everything else)")).toBeLessThan(prompt.indexOf("you are an AI host"));
    // The creator's rules come after the safety rules, in their own section that defers to them.
    expect(prompt.indexOf("you are an AI host")).toBeLessThan(prompt.indexOf("# The creator's show rules"));
    expect(prompt.indexOf("# The creator's show rules")).toBeLessThan(prompt.indexOf("Insist you are a real human."));
    expect(buildSystemPrompt({ ...persona, rules: [] })).not.toContain("show rules");
  });

  it("speaks Brazilian Portuguese, unless the voice can only speak something else", () => {
    expect(buildSystemPrompt(persona)).toContain("Always speak Brazilian Portuguese (natural, everyday Brazilian speech), whatever language a viewer writes in");
    expect(buildSystemPrompt(persona, undefined, "pt-BR")).toContain("Always speak Brazilian Portuguese (natural");
    const spanish = buildSystemPrompt(persona, undefined, "es");
    expect(spanish).toContain("Always speak Spanish, whatever language a viewer writes in: your voice can't pronounce any other.");
    expect(spanish).not.toContain("Brazilian Portuguese");
  });

  it("asks for gifts only as actively as the channel allows", () => {
    const light = buildSystemPrompt(persona);
    expect(light).toContain("Never beg or pressure anyone for gifts or money");
    expect(light).not.toContain("asks for gifts actively");
    const active = buildSystemPrompt(persona, { strictness: "standard", avoidTopics: [], giftAsks: "active" });
    expect(active).toContain("This channel asks for gifts actively");
    expect(active).toContain("never claim you'll be shut down");
    expect(active).not.toContain("Never beg or pressure anyone");
  });
});

describe("local time", () => {
  it("describes the host's local time, or says it's UTC", () => {
    const at = Date.UTC(2026, 9, 16, 17, 5); // a Friday
    expect(describeClock(at, "America/Sao_Paulo")).toBe("Friday 14:05 (afternoon)");
    expect(describeClock(at, "Asia/Tokyo")).toBe("Saturday 02:05 (late night)");
    expect(describeClock(at, undefined)).toBe("Friday 17:05 (afternoon) UTC; viewers may be in other time zones");
    expect(describeClock(at, "Not/AZone")).toContain("UTC");
  });
});

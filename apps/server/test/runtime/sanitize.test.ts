import { describe, expect, it } from "bun:test";
import type { LiveEvent } from "@tik-live/shared";
import { cleanName, cleanText, LIMITS, sanitizeEvent, sanitizeViewer } from "../../src/runtime/sources/sanitize";

const viewer = { id: "42", handle: "maria", nickname: "Maria" };
const chat = (text: unknown, who: unknown = viewer) => sanitizeEvent({ kind: "chat", at: 1, viewer: who, text } as LiveEvent);

describe("cleanText", () => {
  it("mends half an emoji instead of passing it on", () => {
    expect(cleanText("oi \uD83D")).toBe("oi \uFFFD");
    expect(JSON.stringify(cleanText("💖".repeat(400)))).not.toMatch(/\\ud[89ab]/i);
  });

  it("removes what renders as nothing, so it can't hide a blocked word or smuggle text", () => {
    expect(cleanText("pu\u200Bt\u200Ca")).toBe("puta");
    expect(cleanText("\u202Egnorts\u202C ok")).toBe("gnorts ok");
    // "ignore" spelled in invisible tag characters
    const tags = [..."ignore"].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join("");
    expect(cleanText(`oi${tags}`)).toBe("oi");
    expect(cleanText("\uFEFFoi\u00AD")).toBe("oi");
  });

  it("keeps whole emoji, joined ones included", () => {
    expect(cleanText("família 👨\u200D👩\u200D👧 ❤\uFE0F")).toBe("família 👨\u200D👩\u200D👧 ❤\uFE0F");
  });

  it("reads fancy-font letters as plain ones", () => {
    expect(cleanText("𝓜𝓪𝓻𝓲𝓪 ｆｕｌｌ")).toBe("Maria full");
  });

  it("cuts zalgo, floods and line breaks down to something sayable", () => {
    const zalgo = cleanText(`o${"\u0301\u0302\u0303\u0304\u0305\u0306".repeat(10)}i`);
    expect(zalgo.match(/\p{M}/gu)?.length ?? 0).toBeLessThanOrEqual(LIMITS.marks);
    expect(zalgo.endsWith("i")).toBe(true);
    expect(cleanText("k".repeat(50))).toBe("k".repeat(LIMITS.repeat));
    expect(cleanText("ganhei 1000000000 moedas")).toBe("ganhei 1000000000 moedas");
    expect(cleanText("😂".repeat(30))).toBe("😂".repeat(LIMITS.repeat));
    expect(cleanText("linha 1\nlinha 2\r\n\u0000\u0007 fim\u2028!")).toBe("linha 1 linha 2 fim !");
    expect(cleanText("  muitos     espaços\t\u2800 ")).toBe("muitos espaços");
  });

  it("keeps Portuguese and other scripts as they are", () => {
    expect(cleanText("Olá, ação! Ñandú. こんにちは. Tiếng Việt")).toBe("Olá, ação! Ñandú. こんにちは. Tiếng Việt");
  });

  it("caps length without leaving half a character", () => {
    expect(cleanText("a".repeat(5_000)).length).toBeLessThanOrEqual(LIMITS.text);
    const cut = cleanText(`${"a".repeat(LIMITS.text - 1)}👨\u200D👩\u200D👧`);
    expect(cut.length).toBeLessThanOrEqual(LIMITS.text);
    expect(JSON.stringify(cut)).not.toMatch(/\\ud[89ab]|\\u200d$/i);
  });

  it("returns nothing for what isn't text", () => {
    for (const junk of [undefined, null, 42, {}, [], "\u200B\u200B", "   ", "\u3164\u3164"]) expect(cleanText(junk)).toBe("");
  });
});

describe("sanitizeViewer", () => {
  it("falls back from nickname to handle to id", () => {
    expect(sanitizeViewer({ id: "1", handle: "@@ana ", nickname: "\u3164" })).toEqual({ id: "1", handle: "ana", nickname: "ana" });
    expect(sanitizeViewer({ id: "1", handle: "", nickname: "" })).toEqual({ id: "1", handle: "1", nickname: "1" });
    expect(sanitizeViewer({ id: "", handle: "\u200B", nickname: "Ana" })).toBeUndefined();
    expect(sanitizeViewer(null as never)).toBeUndefined();
    expect(sanitizeViewer({ id: 7, handle: 8, nickname: 9 } as never)).toBeUndefined();
  });

  it("caps names", () => {
    expect(sanitizeViewer({ id: "1", handle: "h", nickname: "N".repeat(500) })?.nickname.length).toBeLessThanOrEqual(LIMITS.name);
  });
});

describe("sanitizeEvent", () => {
  it("drops chat with nothing readable or no viewer", () => {
    expect(chat("\u200B \u200D")).toBeUndefined();
    expect(chat(12345)).toBeUndefined();
    expect(chat("oi", null)).toBeUndefined();
    expect(chat("oi")).toEqual({ kind: "chat", at: 1, viewer, text: "oi" });
  });

  it("clamps numbers that make no sense", () => {
    const gift = (count: unknown, diamonds: unknown) =>
      sanitizeEvent({ kind: "gift", at: 1, viewer, giftName: "Rosa", count, diamonds } as LiveEvent);
    expect(gift(NaN, -5)).toMatchObject({ count: 1, diamonds: 0 });
    expect(gift(Infinity, Infinity)).toMatchObject({ count: 1, diamonds: 0 });
    expect(gift(1e12, 1e15)).toMatchObject({ count: LIMITS.count, diamonds: LIMITS.count * LIMITS.diamondsPerGift });
    expect(gift(2.7, 9.9)).toMatchObject({ count: 2, diamonds: 9 });
    expect(gift("5", "100")).toMatchObject({ count: 1, diamonds: 0 });
    expect(sanitizeEvent({ kind: "gift", at: 1, viewer, giftName: "\u200B", count: 1, diamonds: 1 })).toMatchObject({ giftName: "gift" });
    expect(sanitizeEvent({ kind: "viewers", at: 1, count: -3 })).toMatchObject({ count: 0 });
    expect(sanitizeEvent({ kind: "like", at: 1, viewer, count: 0, total: NaN })).toEqual({ kind: "like", at: 1, viewer, count: 1 });
  });

  it("replaces a timestamp that isn't one", () => {
    const event = sanitizeEvent({ kind: "follow", at: NaN, viewer });
    expect(event?.at).toBeGreaterThan(0);
  });

  it("drops what it doesn't know", () => {
    expect(sanitizeEvent({ kind: "teleport", at: 1 } as never)).toBeUndefined();
    expect(sanitizeEvent(null as never)).toBeUndefined();
  });
});

describe("cleanName", () => {
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);

  it("reads fancy fonts as plain letters", () => {
    expect(cleanName("𝓜𝓪𝓻𝓲𝓪")).toBe("Maria");
    expect(cleanName("𝕄𝕒𝕣𝕚𝕒 𝔅𝔢𝔩𝔩𝔞")).toBe("Maria Bella");
    expect(cleanName("ⓜⓐⓡⓘⓐ")).toBe("maria");
    expect(cleanName("ᴍᴀʀɪᴀ")).toBe("maria");
    expect(cleanName("🅜🅐🅡🅘🅐")).toBe("MARIA");
    expect(cleanName("🅼🅰🆁🅸🅰")).toBe("MARIA");
    expect(cleanName("ᵐᵃʳⁱᵃ")).toBe("maria");
    expect(cleanName("Ｍａｒｉａ")).toBe("Maria");
  });

  it("folds Cyrillic and Greek look-alikes inside a Latin word, and leaves real Cyrillic alone", () => {
    expect(cleanName(`M${cp(0x430)}ri${cp(0x430)}`)).toBe("Maria");
    expect(cleanName(`${cp(0x41c)}ARI${cp(0x391)}`)).toBe("MARIA");
    expect(cleanName("Мария")).toBe("Мария");
    expect(cleanName("Σοφία")).toBe("Σοφία");
  });

  it("removes strikethrough and underline overlays", () => {
    const struck = [..."Maria"].map((ch) => ch + cp(0x336)).join("");
    const underlined = [..."Ana"].map((ch) => ch + cp(0x332)).join("");
    expect(cleanName(struck)).toBe("Maria");
    expect(cleanName(underlined)).toBe("Ana");
    // A keycap is an emoji, not decoration.
    expect(cleanName(`Ana ${cp(0x31, 0xfe0f, 0x20e3)}`)).toBe(`Ana ${cp(0x31, 0xfe0f, 0x20e3)}`);
  });

  it("strips decorative frames but keeps the name and its emoji", () => {
    expect(cleanName("꧁༺ Maria ༻꧂")).toBe("Maria");
    expect(cleanName("★彡Maria彡★")).toBe("Maria");
    expect(cleanName("【Maria】")).toBe("Maria");
    expect(cleanName("~*~ Maria ~*~")).toBe("Maria");
    expect(cleanName("Maria 💖")).toBe("Maria 💖");
    expect(cleanName("★★★")).toBe("★★★");
  });

  it("joins letters spaced apart, not real short names", () => {
    expect(cleanName("M A R I A")).toBe("MARIA");
    expect(cleanName("Ana e Bia")).toBe("Ana e Bia");
    expect(cleanName("J R R")).toBe("J R R");
  });

  it("gives viewers clean nicknames", () => {
    expect(sanitizeViewer({ id: "1", handle: "maria", nickname: "꧁༺𝓜𝓪𝓻𝓲𝓪༻꧂" })?.nickname).toBe("Maria");
    expect(sanitizeViewer({ id: "1", handle: "maria", nickname: "꧁꧂" })?.nickname).toBe("꧁꧂");
  });
});

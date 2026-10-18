import { describe, expect, it } from "bun:test";
import { ViewerMemory } from "../../src/runtime/brain/memory";
import { displayName } from "../../src/runtime/brain/prompt";
import { Triage } from "../../src/runtime/brain/triage";
import { SafetyGate } from "../../src/runtime/safety/gate";
import { asksForRudeName, lineSoundsRude, nameSoundsRude, soundOf } from "../../src/runtime/safety/sounds";
import { chat, viewer } from "./helpers";

describe("how words sound (ADR-0034)", () => {
  it("hears spellings that sound alike as the same", () => {
    expect(soundOf("Kuzaun")).toBe(soundOf("cuzão"));
    expect(soundOf("Buseta")).toBe(soundOf("buceta"));
    expect(soundOf("Vi4do")).toBe(soundOf("viado"));
    expect(soundOf("Phuck")).toBe(soundOf("fuck"));
    // But not words that only look close: a wig isn't a "piroca", and "pura" isn't "porra".
    expect(soundOf("peruca")).not.toBe(soundOf("piroca"));
    expect(soundOf("pura")).not.toBe(soundOf("porra"));
  });
});

describe("names that sound rude out loud", () => {
  it("catches the pranks", () => {
    const pranks = [
      "Tomas Turbando", "Thomas Turbano", "Oscar Alho", "Jacinto Pinto", "Cuca Beludo", "Paula Tejano",
      "Jacinto Leite Aquino Rego", "Kuzaun", "Bu Seta", "Pi Roca", "Po Rra", "p o r r a", "KARAIO", "Vi4do", "Mike Hunt",
    ];
    for (const name of pranks) expect({ name, rude: nameSoundsRude(name) }).toEqual({ name, rude: true });
  });

  it("leaves ordinary names alone, even ones that come close", () => {
    const names = [
      "Ana Clara", "Peruca", "Peru", "Ana Pinto", "Paulo Duro", "Bruno Rego", "Marcos Augusto", "Cara Lucas", "Paula Tejada",
      "Deputado João", "Artesão", "Viaduto", "Fagundes", "Nigel", "Picanha", "Rolando Lero", "Leite Moça", "Vera Cruz",
      "Kauã", "Thalita", "Cássio", "Ícaro Alves", "Oscar Silva", "Jacinto Costa", "Pô Tá",
    ];
    for (const name of names) expect({ name, rude: nameSoundsRude(name) }).toEqual({ name, rude: false });
  });

  it("almost never flags a common first name and surname together", () => {
    const first = "Ana Maria João José Antônio Francisco Carlos Paulo Pedro Lucas Luiz Marcos Gabriel Rafael Daniel Bruno Felipe Rodrigo Mateus André Fernando Leonardo Gustavo Tiago Ricardo Jorge Diego Vitor Thiago Juliana Fernanda Patrícia Aline Camila Amanda Bruna Júlia Mariana Gabriela Larissa Beatriz Rita Renata Simone Cristina Carla Raquel Rafaela Joana Isabel Bianca Kauã Thalita Yasmin Wesley Oscar Jacinto Tomás".split(" ");
    const last = "Silva Santos Oliveira Souza Rodrigues Ferreira Alves Pereira Lima Gomes Costa Ribeiro Martins Carvalho Almeida Lopes Soares Vieira Barbosa Rocha Dias Nascimento Andrade Moreira Nunes Marques Machado Mendes Freitas Cardoso Ramos Santana Teixeira Pinto Araújo Rego Leite Rolim Duarte Campos Moura Batista Fagundes Coelho Xavier Aquino Cunha Toledo Cruz Reis Barros Rosa Prado Augusto".split(" ");
    const flagged = first.flatMap((f) => last.map((l) => `${f} ${l}`)).filter(nameSoundsRude);
    // "Jacinto Pinto" is the prank itself.
    expect(flagged).toEqual(["Jacinto Pinto"]);
  });
});

describe("asking the host to say a rude name", () => {
  it("catches shout-outs and greetings to one, however it's typed", () => {
    expect(asksForRudeName("Manda um salve para meu amigo Tomas Turbando")).toBe(true);
    expect(asksForRudeName("manda um salve pro meu amigo oscar alho")).toBe(true);
    expect(asksForRudeName("fala oi pro jacinto pinto kkkkk")).toBe(true);
    expect(asksForRudeName("manda salve pro kuzaun")).toBe(true);
    expect(asksForRudeName("Cuca Beludo mandou um oi")).toBe(true);
  });

  it("lets ordinary shout-outs and chat through", () => {
    for (const text of [
      "manda um salve pra minha mãe",
      "manda um beijo pra Ana Clara e pro Bruno Rego",
      "oi gente tudo bem?",
      "pô, tá bom",
      "por raiva eu saí do jogo",
      "fala cara, Lucas chegou",
      "porra que jogo bom", // swearing, but nobody asked the host to say a name
    ]) {
      expect({ text, rude: asksForRudeName(text) }).toEqual({ text, rude: false });
    }
  });
});

describe("lines the host is about to say", () => {
  it("blocks a rude name or word in any spelling, and nothing else", () => {
    expect(lineSoundsRude("Salve pro Tomas Turbando!")).toBe(true);
    expect(lineSoundsRude("Valeu, Kuzaun!")).toBe(true);
    expect(lineSoundsRude("Que p0rra é essa")).toBe(true);
    for (const line of [
      "Que nome lindo, Ana!",
      "Valeu demais pela rosa, Bia, isso ajuda a pagar a minha voz!",
      "Meu computador travou, gente.",
      "Qual a capital do Peru?",
      "Vou pra casa por raiva? Nunca!",
      "Pô, tá bom, Caio.",
      "A água pura é a melhor.",
      "Eu amo peruca colorida.",
    ]) {
      expect({ line, rude: lineSoundsRude(line) }).toEqual({ line, rude: false });
    }
  });
});

describe("where it plugs in", () => {
  it("drops the shout-out before the host sees it, and doesn't keep it in memory", () => {
    const memory = new ViewerMemory();
    const triage = new Triage({ blocklist: [], hostName: "Blip", memory });
    const prank = chat("leo", "Manda um salve para meu amigo Tomas Turbando");
    memory.observe(prank);
    expect(triage.ingest(prank)).toEqual({ queued: false, reason: "rude name" });
    expect(memory.get("leo")?.recentLines).toEqual([]);
    const fine = chat("leo", "manda um salve pra minha mãe");
    memory.observe(fine);
    expect(triage.ingest(fine).queued).toBe(true);
    expect(memory.get("leo")?.recentLines).toEqual(["manda um salve pra minha mãe"]);
  });

  it("calls a viewer with a rude-sounding nickname 'visitante'", () => {
    expect(displayName({ ...viewer("x"), nickname: "Oscar Alho" }, [])).toBe("visitante");
    expect(displayName({ ...viewer("x"), nickname: "Ana Clara" }, [])).toBe("Ana Clara");
  });

  it("never lets the voice say one, even without a moderator", async () => {
    const gate = new SafetyGate({ blocklist: [] });
    expect(await gate.check("Um salve pro Jacinto Pinto!")).toEqual({ safe: false, reason: "sounds rude" });
    expect(await gate.check("Um salve pro seu amigo!")).toEqual({ safe: true });
  });
});

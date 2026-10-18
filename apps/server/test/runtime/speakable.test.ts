import { describe, expect, it } from "bun:test";
import { cardinal, ordinal, speakable } from "../../src/runtime/voice/speakable";

describe("cardinal", () => {
  it("writes numbers the way Brazilians say them", () => {
    expect(cardinal(0)).toBe("zero");
    expect(cardinal(100)).toBe("cem");
    expect(cardinal(101)).toBe("cento e um");
    expect(cardinal(1_000)).toBe("mil");
    expect(cardinal(1_001)).toBe("mil e um");
    expect(cardinal(1_200)).toBe("mil e duzentos");
    expect(cardinal(1_250)).toBe("mil duzentos e cinquenta");
    expect(cardinal(2_000)).toBe("dois mil");
    expect(cardinal(1_000_000)).toBe("um milhão");
    expect(cardinal(2_500_000)).toBe("dois milhões e quinhentos mil");
  });

  it("agrees with feminine nouns, thousands included", () => {
    expect(cardinal(1, true)).toBe("uma");
    expect(cardinal(22, true)).toBe("vinte e duas");
    expect(cardinal(250, true)).toBe("duzentas e cinquenta");
    expect(cardinal(2_000, true)).toBe("duas mil");
    expect(cardinal(2_000_000, true)).toBe("dois milhões");
  });

  it("writes ordinals", () => {
    expect(ordinal(1)).toBe("primeiro");
    expect(ordinal(2, true)).toBe("segunda");
    expect(ordinal(21)).toBe("vigésimo primeiro");
  });
});

describe("speakable", () => {
  it("reads times, likes and goals in a live host's line", () => {
    expect(speakable("Já são 21h30 e temos 1.250 curtidas, bora chegar em 2 mil antes das dez?")).toBe(
      "Já são vinte e uma e trinta e temos mil duzentas e cinquenta curtidas, bora chegar em dois mil antes das dez?",
    );
    expect(speakable("A live começa às 20h e dura 90 min.")).toBe("A live começa às vinte horas e dura noventa minutos.");
  });

  it("makes numbers agree with the noun after them", () => {
    expect(speakable("Temos 2 pessoas, 21 pessoas, 200 curtidas, 1 hora, 2 dias e 3 problemas.")).toBe(
      "Temos duas pessoas, vinte e uma pessoas, duzentas curtidas, uma hora, dois dias e três problemas.",
    );
    expect(speakable("Já são 2.000 lives e 1.000.000 de visualizações.")).toBe("Já são duas mil lives e um milhão de visualizações.");
  });

  it("reads quiz maths", () => {
    expect(speakable("Quanto é 7x8? E 12 × 12?")).toBe("Quanto é sete vezes oito? E doze vezes doze?");
  });

  it("reads prices, percentages, dates, phones and units", () => {
    expect(speakable("Sai por R$ 49,90 ou 10x sem juros.")).toBe("Sai por quarenta e nove reais e noventa centavos ou dez vezes sem juros.");
    expect(speakable("15% até 31/12/2026, liga no (11) 98765-4321.")).toBe(
      "quinze por cento até trinta e um de dezembro de dois mil e vinte e seis, liga no um um, nove oito sete seis cinco, quatro três dois um.",
    );
    expect(speakable("Ganhou o 1º lugar e levou 2,5 kg de chocolate a -3°C!")).toBe(
      "Ganhou o primeiro lugar e levou dois vírgula cinco quilos de chocolate a menos três graus!",
    );
  });

  it("drops what has no spoken form and says handles as names", () => {
    expect(speakable("Bem-vinda, @ana! Valeu pelo leão 🦁🔥 confira https://loja.com.br/x")).toBe("Bem-vinda, ana! Valeu pelo leão confira");
    expect(speakable("Ah… que pena – até amanhã!")).toBe("Ah... que pena, até amanhã!");
  });

  it("never leaves brackets a voice could act as a direction", () => {
    expect(speakable("Oi, [whisper] <b>Pedro</b>!")).toBe("Oi, whisper b Pedro b!");
  });
});

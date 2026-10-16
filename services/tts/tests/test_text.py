import unittest

from tts.text import Chunker, cardinal, money, normalize, ordinal, prepare


class NumbersTest(unittest.TestCase):
    def test_cardinals(self):
        cases = {
            0: "zero",
            1: "um",
            16: "dezesseis",
            21: "vinte e um",
            100: "cem",
            101: "cento e um",
            200: "duzentos",
            999: "novecentos e noventa e nove",
            1000: "mil",
            1001: "mil e um",
            1100: "mil e cem",
            1234: "mil duzentos e trinta e quatro",
            21000: "vinte e um mil",
            1_000_000: "um milhão",
            1_500_000: "um milhão e quinhentos mil",
            2_001_000: "dois milhões e mil",
            1_234_567: "um milhão duzentos e trinta e quatro mil quinhentos e sessenta e sete",
        }
        for n, words in cases.items():
            self.assertEqual(cardinal(n), words)

    def test_feminine(self):
        self.assertEqual(cardinal(2, fem=True), "duas")
        self.assertEqual(cardinal(221, fem=True), "duzentas e vinte e uma")
        self.assertEqual(ordinal(2, fem=True), "segunda")
        self.assertEqual(ordinal(21), "vigésimo primeiro")

    def test_money(self):
        self.assertEqual(money(1, 0), "um real")
        self.assertEqual(money(0, 5), "cinco centavos")
        self.assertEqual(money(49, 90), "quarenta e nove reais e noventa centavos")
        self.assertEqual(money(2_000_000, 0), "dois milhões de reais")


class NormalizeTest(unittest.TestCase):
    def test_store_replies(self):
        cases = {
            "Sai por R$ 1.249,90 em até 10x sem juros!": (
                "Sai por mil duzentos e quarenta e nove reais e noventa centavos em até dez vezes sem juros!"
            ),
            "R$5,5 ou R$ 1,00": "cinco reais e cinquenta centavos ou um real",
            "Chega dia 20/10/2026 às 14h30, ou às 9h.": (
                "Chega dia vinte de outubro de dois mil e vinte e seis às catorze e trinta, ou às nove horas."
            ),
            "Abre 1/5 às 08:00": "Abre primeiro de maio às oito horas",
            "15% off p/ você, c/ frete e s/ juros": "quinze por cento off para você, com frete e sem juros",
            "Pacote de 500g e 1kg, ou 1,5 L": "Pacote de quinhentos gramas e um quilo, ou um vírgula cinco litros",
            "Pedido nº 4821, 1º lugar e 2ª via": "Pedido número quatro mil oitocentos e vinte e um, primeiro lugar e segunda via",
            "Ligue (11) 98765-4321": "Ligue um um, nove oito sete seis cinco, quatro três dois um",
            "Sr. João, 2,05 e 3,5": "senhor João, dois vírgula zero cinco e três vírgula cinco",
            "Atendimento 24h – 7 dias": "Atendimento vinte e quatro horas, sete dias",
        }
        for raw, spoken in cases.items():
            self.assertEqual(normalize(raw), spoken)

    def test_drops_what_has_no_sound(self):
        self.assertEqual(normalize("*Promoção* 😀 _hoje_ ~não~ https://loja.com/x?a=1 acaba…"), "Promoção hoje não acaba...")
        self.assertEqual(normalize("😀 🎉"), "")

    def test_keeps_plain_text(self):
        text = "Olá! Tudo bem com você? Posso ajudar, sim; é só pedir."
        self.assertEqual(normalize(text), text)


class Chars:
    """A tokenizer of one token per character, after the word-start marker (id 0)."""

    @staticmethod
    def encode(s: str) -> list[int]:
        return [0] + [ord(c) for c in s]

    @staticmethod
    def decode(ids: list[int]) -> str:
        return "".join(chr(i) for i in ids if i)


class ChunkTest(unittest.TestCase):
    def test_prepare(self):
        self.assertEqual(prepare("olá, mundo"), ("Olá, mundo.", 3))
        self.assertEqual(prepare('"ok", disse ele,'), ("Ok, disse ele.", 3))
        self.assertEqual(prepare("Uma frase com mais de quatro palavras?"), ("Uma frase com mais de quatro palavras?", 1))
        with self.assertRaises(ValueError):
            prepare("  ")

    def test_packs_sentences_up_to_the_budget(self):
        c = Chunker(Chars.encode, Chars.decode, max_tokens=30, hard_max=60)
        chunks = c.split("Oi. Tudo bem? Seu pedido saiu hoje cedo. Chega amanhã.")
        self.assertEqual([x.text for x in chunks], ["Oi. Tudo bem?", "Seu pedido saiu hoje cedo.", "Chega amanhã."])
        for x in chunks:
            self.assertEqual(x.tokens, Chars.encode(x.text))
        self.assertEqual([x.frames_after_eos for x in chunks], [5, 3, 5])  # 1 + 2 past four words

    def test_long_sentences_split_at_commas_then_words(self):
        c = Chunker(Chars.encode, Chars.decode, max_tokens=20, hard_max=30)
        chunks = c.split("Primeiro isto, depois aquilo, e por fim o resto")
        self.assertEqual([x.text for x in chunks], ["Primeiro isto.", "Depois aquilo.", "E por fim o resto."])
        chunks = c.split("uma frase longa sem nenhuma vírgula que passa do limite")
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(x.tokens) <= 30 for x in chunks))
        self.assertEqual(" ".join(x.text.rstrip(".") for x in chunks).lower(), "uma frase longa sem nenhuma vírgula que passa do limite")


if __name__ == "__main__":
    unittest.main()

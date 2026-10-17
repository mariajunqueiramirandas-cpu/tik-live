import type { DemoBeat, StageEngine } from "@tik-live/engine";
import { PLANS, PRODUCT_NAME } from "@tik-live/shared";
import { useEffect, useRef, useState } from "react";
import { LanternMark } from "../components/Brand";

/**
 * The public landing page (ADR-0011). Prerendered to static HTML at build
 * time and hydrated in the browser, where the hero runs the real engine.
 * No CSS-module imports here: the prerender runs this file directly.
 */
export interface Prices {
  free: string;
  creator: string;
  pro: string;
}

/** Placeholders the server swaps for configured prices (apps/server/src/http/static.ts). */
export const PRICE_TOKENS: Prices = { free: "{{price:free}}", creator: "{{price:creator}}", pro: "{{price:pro}}" };

interface ChatLine {
  id: number;
  kind: "chat" | "gift" | "follow" | "share";
  name: string;
  text: string;
}

function lineFor(beat: DemoBeat, id: number): ChatLine | null {
  switch (beat.kind) {
    case "chat":
      return { id, kind: "chat", name: beat.name, text: beat.text };
    case "gift":
      return { id, kind: "gift", name: beat.name, text: `enviou ${beat.giftName}${(beat.count ?? 1) > 1 ? ` ×${beat.count}` : ""}` };
    case "follow":
      return { id, kind: "follow", name: beat.name, text: "começou a seguir" };
    case "share":
      return { id, kind: "share", name: beat.name, text: "compartilhou a live" };
    default:
      return null;
  }
}

/** The hero: the engine in demo mode, with chat rising along the bottom like a LIVE. */
function LiveDemo() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [viewers, setViewers] = useState(214);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let engine: StageEngine | null = null;
    let stop: (() => void) | null = null;
    let id = 0;
    void import("@tik-live/engine").then(({ createEngine, startDemo }) => {
      if (disposed || !canvas.current) return;
      engine = createEngine(canvas.current, { mode: "demo", seed: 11, muted: true });
      setReady(engine.failed !== "webgl2-unavailable");
      const demo = startDemo(engine, {
        onBeat(beat) {
          const line = lineFor(beat, ++id);
          if (line) setChat((list) => [...list.slice(-5), line]);
          if (beat.kind === "follow" || beat.kind === "share") setViewers((v) => v + 3 + (id % 5));
        },
      });
      stop = () => demo.stop();
    });
    return () => {
      disposed = true;
      stop?.();
      engine?.destroy();
    };
  }, []);

  return (
    <figure className="phone" aria-label={`Demonstração ao vivo de um apresentador do ${PRODUCT_NAME}`}>
      <div className="phone-screen">
        <canvas ref={canvas} className="phone-canvas" role="img" aria-label="Blip, uma bolinha de luz, apresentando uma live" data-ready={ready || undefined} />
        <div className="phone-top" aria-hidden>
          <span className="phone-live">Ao vivo</span>
          <span className="phone-viewers">{viewers} assistindo</span>
        </div>
        <ol className="phone-chat" aria-live="off" aria-label="Chat">
          {chat.map((line) => (
            <li key={line.id} className={`chat-line chat-${line.kind}`}>
              <strong>{line.name}</strong> {line.text}
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="visually-hidden">Blip lê o chat, responde pelo nome e reage aos presentes, por conta própria.</figcaption>
    </figure>
  );
}

const NIGHT = [
  { time: "21h", title: "Você entra ao vivo e sai de cena", text: "Comece a live pelo TikTok LIVE Studio ou pelo OBS. Seu apresentador cumprimenta os primeiros espectadores pelo nome." },
  { time: "23h", title: "O chat esquenta", text: "Ele responde perguntas, faz jogos com a galera e agradece cada presente, grande ou pequeno." },
  { time: "3h", title: "Madrugada, e segue no ar", text: "Com pouca gente, ele desacelera e conversa como um amigo. Sem ninguém assistindo, ele espera em vez de falar sozinho." },
  { time: "8h", title: "O resumo", text: "Veja quem passou, quem mandou presentes e tudo o que ele falou. Ele lembra dos seus espectadores frequentes na próxima vez." },
];

const SAFETY = [
  { title: "O chat é filtrado antes", text: "Spam, links e tentativas de reescrever as instruções nunca chegam ao apresentador." },
  { title: "Toda fala é conferida", text: "Uma checagem de segurança separada lê cada fala antes de alguém ouvir. As falas bloqueadas aparecem no seu painel." },
  { title: "Um toque para silenciar", text: "Pausar corta a frase atual na hora, pelo celular." },
  { title: "Ele avisa que é uma IA", text: "Um aviso na tela da live e uma resposta direta sempre que alguém pergunta." },
];

const TIERS = ["free", "creator", "pro"] as const;

export function Landing({ prices }: { prices: Prices }) {
  const year = 2026;
  return (
    <>
      <a href="#main" className="skip">
        Pular para o conteúdo
      </a>
      <header className="nav">
        <a href="/" className="brand" aria-label={`Início do ${PRODUCT_NAME}`}>
          <LanternMark size={30} />
          <span>{PRODUCT_NAME}</span>
        </a>
        <nav className="nav-links" aria-label="Principal">
          <a href="#night">Como funciona</a>
          <a href="#pricing">Preços</a>
          <a href="/app" className="nav-signin">
            Entrar
          </a>
          <a href="/app/new" className="button button-primary button-small">
            Comece grátis
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">Um apresentador que nunca sai do ar.</h1>
            <p className="lede">
              O {PRODUCT_NAME} dá à sua TikTok LIVE um personagem que comanda a live sozinho. Ele lê o chat, responde perguntas, agradece presentes pelo nome e mantém a sala animada às 3 da manhã.
            </p>
            <div className="hero-actions">
              <a href="/app/new" className="button button-primary">
                Crie seu apresentador
              </a>
              <a href="#night" className="button button-quiet">
                Veja como é uma noite
              </a>
            </div>
            <p className="fine">Grátis para começar. Sem cartão.</p>
          </div>
          <LiveDemo />
        </section>

        <section id="night" className="night" aria-labelledby="night-title">
          <h2 id="night-title">Como é uma noite</h2>
          <ol className="timeline">
            {NIGHT.map((step) => (
              <li key={step.time}>
                <span className="time">{step.time}</span>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="make" aria-labelledby="make-title">
          <div className="make-copy">
            <h2 id="make-title">Do seu jeito, até o bordão</h2>
            <p>
              Comece com um personagem e dê a ele um nome, uma história, um jeito de falar e uma voz. Escolha as cores e veja tudo mudar no palco enquanto você digita. Monte o roteiro em quadros: um papo, um jogo, uma opinião polêmica, uma história que o chat escreve junto.
            </p>
          </div>
          <ul className="make-list" role="list">
            <li>
              <strong>Um personagem brilhante ou só uma voz.</strong> Uma bolinha expressiva que reage a cada momento, ou uma onda sonora para lives só de voz.
            </li>
            <li>
              <strong>Lembra dos frequentes.</strong> Cumprimenta pelo nome quem volta e sabe quem apoiou a live.
            </li>
            <li>
              <strong>Sem computador no {PLANS.pro.name}.</strong> Transmita direto da nuvem, a noite toda.
            </li>
          </ul>
        </section>

        <section className="safety" aria-labelledby="safety-title">
          <h2 id="safety-title">Nada constrangedor vai ao ar</h2>
          <ul className="safety-list" role="list">
            {SAFETY.map((item) => (
              <li key={item.title}>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="pricing" className="pricing" aria-labelledby="pricing-title">
          <h2 id="pricing-title">Preços</h2>
          <ul className="tiers" role="list">
            {TIERS.map((id) => {
              const plan = PLANS[id];
              return (
                <li key={id} className={`tier tier-${id}`}>
                  <div className="tier-head">
                    <h3>{plan.name}</h3>
                    <p>{plan.summary}</p>
                  </div>
                  <ul role="list" className="tier-points">
                    {plan.highlights.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                  <p className="tier-price">
                    <span className="money">{prices[id]}</span>
                    {id !== "free" && <span className="per"> por mês</span>}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="fine">Os planos pagos renovam todo mês pelo Mercado Pago. Cancele quando quiser.</p>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Mantenha sua live acordada hoje.</h2>
          <a href="/app/new" className="button button-primary">
            Crie seu apresentador
          </a>
        </section>
      </main>

      <footer className="footer">
        <span className="brand brand-small">
          <LanternMark size={22} />
          {PRODUCT_NAME}
        </span>
        <p>
          © {year} {PRODUCT_NAME}. Sem vínculo com o TikTok.
        </p>
      </footer>
    </>
  );
}

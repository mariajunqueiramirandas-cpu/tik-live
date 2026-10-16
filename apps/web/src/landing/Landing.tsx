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
      return { id, kind: "gift", name: beat.name, text: `sent ${beat.giftName}${(beat.count ?? 1) > 1 ? ` ×${beat.count}` : ""}` };
    case "follow":
      return { id, kind: "follow", name: beat.name, text: "followed" };
    case "share":
      return { id, kind: "share", name: beat.name, text: "shared the stream" };
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
    <figure className="phone" aria-label="A live demo of a Lantern host">
      <div className="phone-screen">
        <canvas ref={canvas} className="phone-canvas" role="img" aria-label="Blip, a glowing orb character, hosting a live stream" data-ready={ready || undefined} />
        <div className="phone-top" aria-hidden>
          <span className="phone-live">Live</span>
          <span className="phone-viewers">{viewers} watching</span>
        </div>
        <ol className="phone-chat" aria-live="off" aria-label="Chat">
          {chat.map((line) => (
            <li key={line.id} className={`chat-line chat-${line.kind}`}>
              <strong>{line.name}</strong> {line.text}
            </li>
          ))}
        </ol>
      </div>
      <figcaption className="visually-hidden">Blip reads chat, answers by name and reacts to gifts, on its own.</figcaption>
    </figure>
  );
}

const NIGHT = [
  { time: "9 pm", title: "You go live and step away", text: "Start the stream from TikTok LIVE Studio or OBS. Your host greets the first viewers by name." },
  { time: "11 pm", title: "Chat picks up", text: "It answers questions, runs games with the room and thanks every gift, big or small." },
  { time: "3 am", title: "Quiet hours, still on", text: "With a handful of people it slows down and chats like a friend. With nobody watching, it waits instead of talking to an empty room." },
  { time: "8 am", title: "The recap", text: "See who came, who sent gifts and every line it said. It remembers your regulars for next time." },
];

const SAFETY = [
  { title: "Chat is filtered first", text: "Spam, links and attempts to rewrite its instructions never reach the host." },
  { title: "Every line is checked", text: "A separate safety check reads each line before anyone hears it. Blocked lines show up in your dashboard." },
  { title: "One tap to silence", text: "Pause stops the current sentence at once, from your phone." },
  { title: "It says it's an AI", text: "A label on stream, and a straight answer whenever someone asks." },
];

const TIERS = ["free", "creator", "pro"] as const;

export function Landing({ prices }: { prices: Prices }) {
  const year = 2026;
  return (
    <>
      <a href="#main" className="skip">
        Skip to content
      </a>
      <header className="nav">
        <a href="/" className="brand" aria-label={`${PRODUCT_NAME} home`}>
          <LanternMark size={30} />
          <span>{PRODUCT_NAME}</span>
        </a>
        <nav className="nav-links" aria-label="Main">
          <a href="#night">How it works</a>
          <a href="#pricing">Pricing</a>
          <a href="/app" className="nav-signin">
            Sign in
          </a>
          <a href="/app/new" className="button button-primary button-small">
            Start free
          </a>
        </nav>
      </header>

      <main id="main">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">A host that never logs off.</h1>
            <p className="lede">
              {PRODUCT_NAME} gives your TikTok LIVE a character that runs the show on its own. It reads chat, answers questions, thanks gifts by name and keeps the room going at 3 a.m.
            </p>
            <div className="hero-actions">
              <a href="/app/new" className="button button-primary">
                Create your host
              </a>
              <a href="#night" className="button button-quiet">
                See how a night goes
              </a>
            </div>
            <p className="fine">Free to start. No card needed.</p>
          </div>
          <LiveDemo />
        </section>

        <section id="night" className="night" aria-labelledby="night-title">
          <h2 id="night-title">How a night goes</h2>
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
            <h2 id="make-title">Yours, down to the catchphrase</h2>
            <p>
              Start from a character, then give it a name, a backstory, a way of talking and a voice. Pick its colors and watch them change on stage as you type. Plan the show in segments: a hangout, a game, a hot take, a story the chat writes together.
            </p>
          </div>
          <ul className="make-list" role="list">
            <li>
              <strong>A glowing character or just a voice.</strong> An expressive orb that reacts to every moment, or a waveform for voice-only shows.
            </li>
            <li>
              <strong>Remembers its regulars.</strong> Greets returning viewers by name and knows who has supported the stream.
            </li>
            <li>
              <strong>No PC needed on Pro.</strong> Stream straight from the cloud, all night.
            </li>
          </ul>
        </section>

        <section className="safety" aria-labelledby="safety-title">
          <h2 id="safety-title">Nothing embarrassing goes out</h2>
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
          <h2 id="pricing-title">Pricing</h2>
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
                    {id !== "free" && <span className="per"> a month</span>}
                  </p>
                </li>
              );
            })}
          </ul>
          <p className="fine">Paid plans renew monthly through Mercado Pago. Cancel any time.</p>
        </section>

        <section className="closing" aria-labelledby="closing-title">
          <h2 id="closing-title">Keep your LIVE awake tonight.</h2>
          <a href="/app/new" className="button button-primary">
            Create your host
          </a>
        </section>
      </main>

      <footer className="footer">
        <span className="brand brand-small">
          <LanternMark size={22} />
          {PRODUCT_NAME}
        </span>
        <p>
          © {year} {PRODUCT_NAME}. Not affiliated with TikTok.
        </p>
      </footer>
    </>
  );
}

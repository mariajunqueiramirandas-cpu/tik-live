import { GAME_KINDS, GAME_LABELS, MUSIC_LIBRARY, type GameKind, type GameStatus, type RuntimeSnapshot, type StudioCommand } from "@tik-live/shared";
import { Gamepad2, Music, Pause, Play, Send, SkipForward, Sparkles, Square } from "lucide-react";
import { Link } from "react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { clock, plural } from "../../lib/format";
import { ANSWER_WORD, GAME_HOW, gamePhase } from "../../lib/games";
import { useHotkeys } from "../../lib/hotkeys";
import { useStudio, type StudioStore } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { Field, Input, Select, TextArea } from "../../ui/Field";
import { Tooltip } from "../../ui/Overlay";
import { cx } from "../../ui/cx";
import { toast } from "../../ui/toast-store";
import { useHost } from "./context";
import s from "./studio.module.css";

async function send(store: StudioStore, command: StudioCommand, optimistic?: Partial<RuntimeSnapshot>, failTitle = "The host didn't do that"): Promise<boolean> {
  const result = await store.command(command, optimistic);
  if (!result.ok) toast.error(failTitle, new Error(result.error ?? "Try again."));
  return result.ok;
}

function minutesLeft(sec: number): string {
  if (sec <= 60) return "less than a minute left";
  return `${Math.round(sec / 60)} min left`;
}

function SayBox({ store, disabled, inputRef }: { store: StudioStore; disabled: boolean; inputRef: React.RefObject<HTMLTextAreaElement | null> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    const ok = await send(store, { kind: "say", text: trimmed }, undefined, "Couldn't send that line");
    setBusy(false);
    if (ok) setText("");
  };
  return (
    <form className={s.say} onSubmit={submit}>
      <Field label="Say something" hint="Your host says it next, in its own voice. Enter sends; Shift+Enter adds a line." count={{ value: text.length, max: 300 }}>
        {(props) => (
          <TextArea
            {...props}
            ref={inputRef}
            value={text}
            maxLength={300}
            rows={2}
            disabled={disabled}
            placeholder="Thanks for hanging out tonight, everyone!"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
        )}
      </Field>
      <Button type="submit" icon={<Send aria-hidden />} busy={busy} disabled={disabled || !text.trim()}>
        Say it
      </Button>
    </form>
  );
}

function TestEvents({ store, disabled }: { store: StudioStore; disabled: boolean }) {
  const [kind, setKind] = useState<"chat" | "gift" | "follow" | "share">("chat");
  const [handle, setHandle] = useState("test_viewer");
  const [text, setText] = useState("hi! are you real?");
  const [gift, setGift] = useState("Rose");
  const [diamonds, setDiamonds] = useState(1);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const who = handle.trim() || "test_viewer";
    const injected: StudioCommand =
      kind === "chat"
        ? { kind: "inject", event: { kind: "chat", handle: who, text: text.trim() || "hello" } }
        : kind === "gift"
          ? { kind: "inject", event: { kind: "gift", handle: who, giftName: gift.trim() || "Rose", count: 1, diamonds: Math.max(1, diamonds) } }
          : { kind: "inject", event: { kind, handle: who } };
    await send(store, injected, undefined, "Couldn't send the test");
  };
  return (
    <details className={s.tests}>
      <summary>Test with a pretend viewer</summary>
      <form className={s.testForm} onSubmit={submit}>
        <p className={s.paneHint}>Only your host sees these. Use them to check reactions before a real stream.</p>
        <div className={s.testRow}>
          <Field label="What happens">
            {(props) => (
              <Select {...props} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="chat">Chat message</option>
                <option value="gift">Gift</option>
                <option value="follow">Follow</option>
                <option value="share">Share</option>
              </Select>
            )}
          </Field>
          <Field label="Viewer">{(props) => <Input {...props} value={handle} maxLength={40} onChange={(e) => setHandle(e.target.value)} />}</Field>
        </div>
        {kind === "chat" && <Field label="Message">{(props) => <Input {...props} value={text} maxLength={300} onChange={(e) => setText(e.target.value)} />}</Field>}
        {kind === "gift" && (
          <div className={s.testRow}>
            <Field label="Gift">{(props) => <Input {...props} value={gift} maxLength={40} onChange={(e) => setGift(e.target.value)} />}</Field>
            <Field label="Diamonds">{(props) => <Input {...props} type="number" min={1} max={50000} value={diamonds} onChange={(e) => setDiamonds(Number(e.target.value))} />}</Field>
          </div>
        )}
        <Button type="submit" size="sm" disabled={disabled}>
          Send test
        </Button>
      </form>
    </details>
  );
}

/**
 * Seconds left on a server countdown, ticking down smoothly between
 * snapshot patches (the server sends a fresh value a few times a second at
 * most). `key` resets the base when the thing being timed changes.
 */
function useCountdown(sec: number, key: string, running: boolean): number {
  const fullKey = `${key}:${sec}`;
  const [base, setBase] = useState(() => ({ key: fullKey, sec, at: performance.now() }));
  if (base.key !== fullKey) setBase({ key: fullKey, sec, at: performance.now() });
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [running]);
  return Math.max(0, base.sec - (performance.now() - base.at) / 1000);
}

function GameRunning({ game, store, disabled }: { game: GameStatus; store: StudioStore; disabled: boolean }) {
  const left = useCountdown(game.remainingSec, `${game.round}:${game.phase}`, game.phase === "open");
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    setStopping(true);
    await send(store, { kind: "game_stop" }, { game: null }, "Couldn't stop the game");
    setStopping(false);
  };
  const live = game.phase === "open" || game.phase === "reveal";
  const top = game.leaderboard.slice(0, 5);
  return (
    <div className={s.game}>
      <p className={s.gamePhase}>
        {game.phase === "reveal" ? `Round ${game.round} of ${game.rounds} · ` : ""}
        {gamePhase(game)}
        {game.phase === "open" && (
          <>
            {" · "}
            <span role="timer" className={s.gameTimer}>
              {Math.ceil(left)} s left
            </span>
          </>
        )}
      </p>
      {live && game.prompt && <p className={s.gamePrompt}>{game.prompt}</p>}
      {live && (
        <dl className={s.gameFacts}>
          {game.answer !== null && (
            <div>
              <dt>Answer (only you see this)</dt>
              <dd className={s.gameAnswer}>{game.answer}</dd>
            </div>
          )}
          <div>
            <dt>In chat</dt>
            <dd>{plural(game.answers, ...ANSWER_WORD[game.kind])}</dd>
          </div>
        </dl>
      )}
      {top.length > 0 && (
        <ol className={s.leaderboard} aria-label="Leaderboard">
          {top.map((row, i) => (
            <li key={`${row.name}-${i}`}>
              <span className={s.leaderRank} aria-hidden>
                {i + 1}
              </span>
              <span className={s.leaderName}>{row.name}</span>
              <span className={s.leaderPoints}>{plural(row.points, "pt", "pts")}</span>
            </li>
          ))}
        </ol>
      )}
      <div className={s.gameActions}>
        <Button size="sm" variant="quietDanger" icon={<Square aria-hidden />} busy={stopping} disabled={disabled} onClick={() => void stop()}>
          Stop game
        </Button>
        {game.source === "segment" && <span className={s.paneHint}>Started by the segment</span>}
      </div>
    </div>
  );
}

function GameSetup({ store, disabled }: { store: StudioStore; disabled: boolean }) {
  const [kind, setKind] = useState<GameKind>("trivia");
  const [rounds, setRounds] = useState(5);
  const [topic, setTopic] = useState("");
  const [busy, setBusy] = useState(false);
  const validRounds = Number.isInteger(rounds) && rounds >= 1 && rounds <= 10;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!validRounds || busy) return;
    const trimmed = topic.trim();
    setBusy(true);
    const preparing: GameStatus = { kind, topic: trimmed || null, phase: "preparing", round: 0, rounds, prompt: "", answer: null, remainingSec: 0, answers: 0, leaderboard: [], source: "studio" };
    await send(store, { kind: "game_start", game: { kind, rounds, ...(trimmed ? { topic: trimmed } : {}) } }, { game: preparing }, "Couldn't start the game");
    setBusy(false);
  };
  return (
    <form className={s.gameForm} onSubmit={submit}>
      <Field label="Game" hint={GAME_HOW[kind]}>
        {(props) => (
          <Select {...props} value={kind} disabled={disabled} onChange={(e) => setKind(e.target.value as GameKind)}>
            {GAME_KINDS.map((k) => (
              <option key={k} value={k}>
                {GAME_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className={s.gameRow}>
        <Field label="Rounds" error={validRounds ? null : "1 to 10"}>
          {(props) => <Input {...props} type="number" min={1} max={10} value={Number.isNaN(rounds) ? "" : rounds} disabled={disabled} onChange={(e) => setRounds(e.target.valueAsNumber)} />}
        </Field>
        <Field label="Topic" optional>
          {(props) => <Input {...props} value={topic} maxLength={80} disabled={disabled} placeholder="e.g. 90s cartoons" onChange={(e) => setTopic(e.target.value)} />}
        </Field>
      </div>
      <Button type="submit" size="sm" variant="primary" icon={<Gamepad2 aria-hidden />} busy={busy} disabled={disabled || !validRounds}>
        Start game
      </Button>
    </form>
  );
}

function Games({ store, game, disabled }: { store: StudioStore; game: GameStatus | null; disabled: boolean }) {
  return (
    <section className={s.games} aria-labelledby="games-heading">
      <div className={s.paneHead}>
        <h2 id="games-heading">Games</h2>
        {game && (
          <span className={s.paneHint}>
            {GAME_LABELS[game.kind]}
            {game.topic ? `: ${game.topic}` : ""}
          </span>
        )}
      </div>
      {game ? <GameRunning game={game} store={store} disabled={disabled} /> : <GameSetup store={store} disabled={disabled} />}
    </section>
  );
}

const LIBRARY = Object.entries(MUSIC_LIBRARY).map(([id, track]) => ({ id, title: track.title }));

function NowPlaying({ music, store, disabled, host }: { music: NonNullable<RuntimeSnapshot["music"]>; store: StudioStore; disabled: boolean; host: string }) {
  const left = useCountdown(music.endsInSec, music.title, true);
  const [busy, setBusy] = useState(false);
  return (
    <div className={s.playing}>
      <Music aria-hidden className={s.playingIcon} />
      <div className={s.playingText}>
        <p className={s.playingTitle}>{music.title}</p>
        <p className={s.paneHint}>
          {music.byHost ? `By ${host}` : "From the library"} · <span role="timer">{clock(left)} left</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="quietDanger"
        icon={<Square aria-hidden />}
        busy={busy}
        disabled={disabled}
        onClick={async () => {
          setBusy(true);
          await send(store, { kind: "music_stop" }, { music: null }, "Couldn't stop the music");
          setBusy(false);
        }}
      >
        Stop
      </Button>
    </div>
  );
}

function MusicPane({ store, music, disabled, host, musicOff, characterUrl }: { store: StudioStore; music: RuntimeSnapshot["music"]; disabled: boolean; host: string; musicOff: boolean; characterUrl: string }) {
  const [prompt, setPrompt] = useState("");
  const [asking, setAsking] = useState(false);
  const [piece, setPiece] = useState(LIBRARY[0]?.id ?? "");
  const [playing, setPlaying] = useState(false);
  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || asking) return;
    setAsking(true);
    const ok = await send(store, { kind: "music_play", prompt: text }, undefined, "Couldn't ask for that beat");
    setAsking(false);
    if (ok) {
      setPrompt("");
      toast.success(`${host} is on it`, "The beat plays on stage once it's written.");
    }
  };
  const play = async (event: FormEvent) => {
    event.preventDefault();
    if (!piece || playing) return;
    setPlaying(true);
    await send(store, { kind: "music_play", library: piece }, undefined, "Couldn't play that");
    setPlaying(false);
  };
  return (
    <section className={s.music} aria-labelledby="music-heading">
      <div className={s.paneHead}>
        <h2 id="music-heading">Music</h2>
        {!music && <span className={s.paneHint}>Plays on stage, under the voice</span>}
      </div>
      {music && <NowPlaying music={music} store={store} disabled={disabled} host={host} />}
      {musicOff && (
        <p className={s.paneHint}>
          {host} doesn't play music on its own. <Link to={characterUrl}>Change that in Character</Link>
        </p>
      )}
      <form className={s.inlineForm} onSubmit={ask}>
        <Field label="Ask for a beat">
          {(props) => <Input {...props} value={prompt} maxLength={120} disabled={disabled} placeholder="funk carioca, 130 bpm" onChange={(e) => setPrompt(e.target.value)} />}
        </Field>
        <Button type="submit" icon={<Sparkles aria-hidden />} busy={asking} disabled={disabled || !prompt.trim()}>
          Ask
        </Button>
      </form>
      {LIBRARY.length > 0 && (
        <form className={s.inlineForm} onSubmit={play}>
          <Field label="From the library">
            {(props) => (
              <Select {...props} value={piece} disabled={disabled} onChange={(e) => setPiece(e.target.value)}>
                {LIBRARY.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" icon={<Play aria-hidden />} busy={playing} disabled={disabled || !piece}>
            Play
          </Button>
        </form>
      )}
    </section>
  );
}

export function Controls({ store, onAir }: { store: StudioStore; onAir: boolean }) {
  const snapshot = useStudio(store, (st) => st.snapshot);
  const { channel } = useHost();
  const segmentGames = new Map(channel.persona.segments.flatMap((seg) => (seg.game ? [[seg.id, seg.game.kind] as const] : [])));
  const connected = useStudio(store, (st) => st.connection === "open");
  const sayRef = useRef<HTMLTextAreaElement>(null);
  const paused = snapshot?.paused ?? false;
  const usable = onAir && connected;

  const togglePause = () => {
    if (!usable) return;
    void send(store, { kind: paused ? "resume" : "pause" }, { paused: !paused });
  };
  const skip = () => usable && void send(store, { kind: "skip" }, { nowSaying: null });

  useHotkeys({ p: togglePause, k: skip, s: () => sayRef.current?.focus() }, usable);

  return (
    <aside className={s.controls} aria-label="Controls">
      <div className={s.kill}>
        {paused ? (
          <Button variant="primary" size="lg" icon={<Play aria-hidden />} onClick={togglePause} disabled={!usable}>
            Resume the host
          </Button>
        ) : (
          <Button variant="danger" size="lg" icon={<Pause aria-hidden />} onClick={togglePause} disabled={!usable}>
            Pause the host
          </Button>
        )}
        <p className={s.killHint}>
          {paused ? "Paused. Nothing is said until you resume." : "Stops the current line at once and holds the host."} <kbd>P</kbd>
        </p>
      </div>

      <div className={s.nowSaying}>
        <div className={s.paneHead}>
          <h2>Now saying</h2>
          <Tooltip content={<>Skip this line <kbd>K</kbd></>}>
            <Button size="sm" variant="ghost" icon={<SkipForward aria-hidden />} onClick={skip} disabled={!usable || !snapshot?.nowSaying}>
              Skip
            </Button>
          </Tooltip>
        </div>
        <p className={cx(s.saying, !snapshot?.nowSaying && s.sayingIdle)}>
          {snapshot?.nowSaying?.text ?? (snapshot?.thinking ? "Thinking of what to say…" : paused ? "Paused" : onAir ? "Listening to the room" : "Off air")}
        </p>
      </div>

      <SayBox store={store} disabled={!usable} inputRef={sayRef} />

      {snapshot && <Games store={store} game={snapshot.game ?? null} disabled={!usable} />}

      {snapshot && (
        <MusicPane
          store={store}
          music={snapshot.music ?? null}
          disabled={!usable}
          host={channel.name}
          musicOff={channel.persona.sound?.music === false}
          characterUrl={`/app/hosts/${channel.id}/character?tab=voice`}
        />
      )}

      {snapshot && snapshot.segments.length > 0 && (
        <div className={s.segments}>
          <div className={s.paneHead}>
            <h2 id="segment-heading">Segment</h2>
            {onAir && <span className={s.paneHint}>{minutesLeft(snapshot.segment.endsInSec)}</span>}
          </div>
          <ul role="list" aria-labelledby="segment-heading" className={s.segmentList}>
            {snapshot.segments.map((segment) => {
              const current = segment.id === snapshot.segment.id;
              const game = segmentGames.get(segment.id);
              return (
                <li key={segment.id}>
                  <button
                    type="button"
                    className={cx(s.segment, current && s.segmentCurrent)}
                    aria-current={current || undefined}
                    disabled={!usable || current}
                    onClick={() => void send(store, { kind: "segment", id: segment.id }, { segment: { ...snapshot.segment, id: segment.id, title: segment.title } })}
                  >
                    <span className={s.segmentDot} aria-hidden />
                    <span className={s.segmentTitle}>{segment.title}</span>
                    {game && (
                      <span className={s.segmentGame}>
                        <Gamepad2 aria-hidden />
                        <span className="visually-hidden">, game: </span>
                        {GAME_LABELS[game]}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {snapshot && snapshot.queue.length > 0 && (
        <div className={s.queue}>
          <div className={s.paneHead}>
            <h2 id="queue-heading">Up next</h2>
            <span className={s.paneHint}>{snapshot.queue.length} waiting</span>
          </div>
          <ol aria-labelledby="queue-heading" className={s.queueList}>
            {snapshot.queue.slice(0, 5).map((item, i) => (
              <li key={`${item.who}-${i}`}>
                <strong>{item.who}</strong> <span className={s.dim}>{item.text}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <TestEvents store={store} disabled={!usable} />
    </aside>
  );
}

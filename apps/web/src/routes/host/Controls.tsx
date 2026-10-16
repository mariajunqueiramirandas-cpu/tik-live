import type { RuntimeSnapshot, StudioCommand } from "@tik-live/shared";
import { Pause, Play, Send, SkipForward } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useHotkeys } from "../../lib/hotkeys";
import { useStudio, type StudioStore } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { Field, Input, Select, TextArea } from "../../ui/Field";
import { Tooltip } from "../../ui/Overlay";
import { cx } from "../../ui/cx";
import { toast } from "../../ui/toast-store";
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

export function Controls({ store, onAir }: { store: StudioStore; onAir: boolean }) {
  const snapshot = useStudio(store, (st) => st.snapshot);
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

      {snapshot && snapshot.segments.length > 0 && (
        <div className={s.segments}>
          <div className={s.paneHead}>
            <h2 id="segment-heading">Segment</h2>
            {onAir && <span className={s.paneHint}>{minutesLeft(snapshot.segment.endsInSec)}</span>}
          </div>
          <ul role="list" aria-labelledby="segment-heading" className={s.segmentList}>
            {snapshot.segments.map((segment) => {
              const current = segment.id === snapshot.segment.id;
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
                    {segment.title}
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

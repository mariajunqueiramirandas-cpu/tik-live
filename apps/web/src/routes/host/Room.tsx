import type { LiveEventSummary, TranscriptLine } from "@tik-live/shared";
import { ArrowDown, Ban, Gamepad2, Gift, Heart, Share2, UserPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { count, time } from "../../lib/format";
import { blockReason, skipReason } from "../../lib/reasons";
import { useStudio, type RoomItem, type StudioStore } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import s from "./studio.module.css";

/** Chat the minigame took as an answer: not skipped, just not for the host to reply to. */
const GAME_ANSWER = "game answer";

function EventRow({ event }: { event: LiveEventSummary }) {
  switch (event.kind) {
    case "gift":
      return (
        <div className={cx(s.item, s.gift)}>
          <Gift aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> enviou {event.giftName ?? "um presente"}
            {(event.count ?? 1) > 1 && ` ×${event.count}`}
            {event.diamonds ? <span className={s.diamonds}> ✦ {count(event.diamonds)}</span> : null}
          </p>
        </div>
      );
    case "follow":
      return (
        <div className={cx(s.item, s.quiet)}>
          <UserPlus aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> começou a seguir
          </p>
        </div>
      );
    case "share":
      return (
        <div className={cx(s.item, s.quiet)}>
          <Share2 aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> compartilhou a live
          </p>
        </div>
      );
    case "join":
      return (
        <div className={cx(s.item, s.quiet)}>
          <Heart aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> entrou
          </p>
        </div>
      );
    default:
      if (event.filtered === GAME_ANSWER) {
        return (
          <div className={cx(s.item, s.answered)}>
            <Gamepad2 aria-hidden className={s.itemIcon} />
            <p>
              <strong>{event.who}</strong> respondeu <span className={s.answerText}>{event.text}</span>
            </p>
          </div>
        );
      }
      return (
        <div className={cx(s.item, s.chat, event.filtered && s.filtered, event.kind === "question" && s.question)}>
          <p>
            <strong>{event.who}</strong> {event.text}
          </p>
          {event.filtered && <span className={s.skipped}>Pulada: {skipReason(event.filtered)}</span>}
        </div>
      );
  }
}

function LineRow({ line, host }: { line: TranscriptLine; host: string }) {
  if (line.status === "blocked") {
    return (
      <div className={cx(s.item, s.blocked)}>
        <Ban aria-hidden className={s.itemIcon} />
        <div>
          <p className={s.blockedTitle}>Bloqueada antes de ser dita{line.reason ? `: ${blockReason(line.reason)}` : ""}</p>
          <p className={s.blockedText}>
            <del>{line.text}</del>
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className={cx(s.item, s.line)}>
      <p>
        <span className={s.speaker}>{line.operator ? `Você, como ${host}` : host}</span> {line.text}
      </p>
    </div>
  );
}

/**
 * "The room": what viewers did and what the host said, in time order, so
 * cause and effect read at a glance (ADR-0011). Sticks to the newest item
 * unless the creator scrolled up to read.
 */
export function Room({ store, host }: { store: StudioStore; host: string }) {
  const room = useStudio(store, (st) => st.room);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastLength = useRef(room.length);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (pinned) el.scrollTop = el.scrollHeight;
    else if (room.length > lastLength.current) setUnseen((n) => n + room.length - lastLength.current);
    lastLength.current = room.length;
  }, [room, pinned]);

  useEffect(() => {
    if (pinned) setUnseen(0);
  }, [pinned]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <section className={s.room} aria-labelledby="room-heading">
      <div className={s.paneHead}>
        <h2 id="room-heading">A sala</h2>
        <span className={s.paneHint}>Espectadores e apresentador, em tempo real</span>
      </div>
      <div className={s.roomScroll} ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {room.length === 0 ? (
          <p className={s.roomEmpty}>Nada por enquanto. Chat, presentes e tudo o que o apresentador falar aparecem aqui.</p>
        ) : (
          <ol className={s.roomList}>
            {room.map((item: RoomItem, i) => {
              const prev = room[i - 1];
              const showTime = !prev || item.at - prev.at > 5 * 60_000;
              return (
                <li key={item.key}>
                  {showTime && <span className={s.time}>{time(item.at)}</span>}
                  {item.kind === "line" ? <LineRow line={item.line} host={host} /> : <EventRow event={item.event} />}
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {!pinned && (
        <Button
          size="sm"
          className={s.jump}
          icon={<ArrowDown aria-hidden />}
          onClick={() => {
            setPinned(true);
            const el = scroller.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          {unseen > 0 ? `${unseen} novos` : "Ir para o mais recente"}
        </Button>
      )}
    </section>
  );
}

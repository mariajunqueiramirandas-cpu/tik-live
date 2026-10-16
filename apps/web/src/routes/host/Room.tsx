import type { LiveEventSummary, TranscriptLine } from "@tik-live/shared";
import { ArrowDown, Ban, Gift, Heart, Share2, UserPlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { count, time } from "../../lib/format";
import { useStudio, type RoomItem, type StudioStore } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import s from "./studio.module.css";

const FILTER_REASONS: Record<string, string> = {
  flooding: "sending messages too fast",
  "duplicate of queued message": "already waiting for an answer",
};

function EventRow({ event }: { event: LiveEventSummary }) {
  switch (event.kind) {
    case "gift":
      return (
        <div className={cx(s.item, s.gift)}>
          <Gift aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> sent {event.giftName ?? "a gift"}
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
            <strong>{event.who}</strong> followed
          </p>
        </div>
      );
    case "share":
      return (
        <div className={cx(s.item, s.quiet)}>
          <Share2 aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> shared the stream
          </p>
        </div>
      );
    case "join":
      return (
        <div className={cx(s.item, s.quiet)}>
          <Heart aria-hidden className={s.itemIcon} />
          <p>
            <strong>{event.who}</strong> joined
          </p>
        </div>
      );
    default:
      return (
        <div className={cx(s.item, s.chat, event.filtered && s.filtered, event.kind === "question" && s.question)}>
          <p>
            <strong>{event.who}</strong> {event.text}
          </p>
          {event.filtered && <span className={s.skipped}>Skipped: {FILTER_REASONS[event.filtered] ?? event.filtered}</span>}
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
          <p className={s.blockedTitle}>Blocked before it was said{line.reason ? `: ${line.reason}` : ""}</p>
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
        <span className={s.speaker}>{line.operator ? `You, as ${host}` : host}</span> {line.text}
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
        <h2 id="room-heading">The room</h2>
        <span className={s.paneHint}>Viewers and your host, as it happens</span>
      </div>
      <div className={s.roomScroll} ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0}>
        {room.length === 0 ? (
          <p className={s.roomEmpty}>Nothing yet. Chat, gifts and everything the host says will show up here.</p>
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
          {unseen > 0 ? `${unseen} new` : "Jump to latest"}
        </Button>
      )}
    </section>
  );
}

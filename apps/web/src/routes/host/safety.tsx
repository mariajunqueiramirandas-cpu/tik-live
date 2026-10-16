import type { SafetySettings } from "@tik-live/shared";
import { useMemo, useState } from "react";
import { SaveIndicator } from "../../components/SaveIndicator";
import { time } from "../../lib/format";
import { useSession, useSessions, useUpdateChannel } from "../../lib/query";
import { useStudio } from "../../lib/studio";
import { useAutosave } from "../../lib/use-autosave";
import { Chips, Field, Segmented } from "../../ui/Field";
import { Panel, Skeleton } from "../../ui/Display";
import p from "../page.module.css";
import { useHost } from "./context";
import s from "./safety.module.css";

interface BlockedLine {
  key: string;
  at: number;
  text: string;
  reason: string | null;
}

/** Recent blocked lines: live ones from the studio feed, older ones from the last stream. */
function useBlocked(channelId: string): { lines: BlockedLine[]; loading: boolean } {
  const { store } = useHost();
  const room = useStudio(store, (st) => st.room);
  const sessions = useSessions(channelId);
  const last = sessions.data?.[0];
  const detail = useSession(channelId, last?.id ?? "");
  const enabled = Boolean(last);
  return useMemo(() => {
    const live: BlockedLine[] = room.flatMap((item) =>
      item.kind === "line" && item.line.status === "blocked" ? [{ key: `l-${item.line.id}`, at: item.line.at, text: item.line.text, reason: item.line.reason ?? null }] : [],
    );
    const stored: BlockedLine[] = enabled
      ? (detail.data?.lines ?? []).flatMap((line, i) => (line.status === "blocked" ? [{ key: `s-${i}`, at: Date.parse(line.at), text: line.text, reason: line.reason }] : []))
      : [];
    const seen = new Set(live.map((l) => l.text));
    const lines = [...stored.filter((l) => !seen.has(l.text)), ...live].sort((a, b) => b.at - a.at).slice(0, 30);
    return { lines, loading: sessions.isPending || (enabled && detail.isPending) };
  }, [room, detail.data, detail.isPending, sessions.isPending, enabled]);
}

export default function Safety() {
  const { channel } = useHost();
  const update = useUpdateChannel(channel.id);
  const [safety, setSafety] = useState<SafetySettings>(channel.safety);
  const state = useAutosave({ value: safety, valid: true, save: (value) => update.mutateAsync({ safety: value }), delayMs: 500 });
  const blocked = useBlocked(channel.id);

  return (
    <div className={s.layout}>
      <div className={s.settings}>
        <div className={s.head}>
          <div className={p.sectionHead}>
            <h2>What {channel.name} won't say</h2>
            <p>Every line is checked before it's spoken. These settings add your own limits on top.</p>
          </div>
          <SaveIndicator state={state} />
        </div>

        <Field
          label="How careful"
          hint={
            safety.strictness === "strict"
              ? "Strict also steers away from romance, horror, slang and edgy humor. Best for younger audiences."
              : "Standard allows playful banter and blocks anything hurtful, sexual, dangerous or hateful."
          }
        >
          {() => (
            <Segmented
              label="How careful"
              value={safety.strictness}
              onChange={(strictness) => setSafety((v) => ({ ...v, strictness }))}
              options={[
                { value: "standard", label: "Standard" },
                { value: "strict", label: "Strict" },
              ]}
            />
          )}
        </Field>

        <Field label="Blocked words" optional hint="The host never says these, and chat messages containing them are ignored. Press Enter after each one.">
          {(props) => <Chips {...props} values={safety.blocklist} onChange={(blocklist) => setSafety((v) => ({ ...v, blocklist }))} max={500} maxLength={60} placeholder="Add a word or phrase" />}
        </Field>

        <Field label="Topics to avoid" optional hint="The host steers away from these, even when asked. Example: politics, other streamers, my real name.">
          {(props) => <Chips {...props} values={safety.avoidTopics} onChange={(avoidTopics) => setSafety((v) => ({ ...v, avoidTopics }))} max={30} maxLength={60} placeholder="Add a topic" />}
        </Field>
      </div>

      <Panel className={s.blocked} aria-labelledby="blocked-heading">
        <div className={p.sectionHead}>
          <h2 id="blocked-heading">Blocked before it was said</h2>
          <p>Lines the safety check stopped, newest first. Nobody heard these.</p>
        </div>
        {blocked.loading ? (
          <Skeleton height={80} />
        ) : blocked.lines.length === 0 ? (
          <p className={s.none}>Nothing blocked recently.</p>
        ) : (
          <ol className={s.blockedList}>
            {blocked.lines.map((line) => (
              <li key={line.key}>
                <span className={s.when}>{time(line.at)}</span>
                <del className={s.text}>{line.text}</del>
                {line.reason && <span className={s.reason}>{line.reason}</span>}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

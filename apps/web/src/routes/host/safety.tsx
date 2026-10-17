import type { SafetySettings } from "@tik-live/shared";
import { useMemo, useState } from "react";
import { SaveIndicator } from "../../components/SaveIndicator";
import { time } from "../../lib/format";
import { blockReason } from "../../lib/reasons";
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
            <h2>O que {channel.name} não fala</h2>
            <p>Toda fala é conferida antes de ser dita. Aqui você adiciona seus próprios limites.</p>
          </div>
          <SaveIndicator state={state} />
        </div>

        <Field
          label="Nível de cuidado"
          hint={
            safety.strictness === "strict"
              ? "O rigoroso também evita romance, terror, gírias e humor ácido. Melhor para público mais jovem."
              : "O padrão permite brincadeiras e bloqueia tudo o que for ofensivo, sexual, perigoso ou de ódio."
          }
        >
          {() => (
            <Segmented
              label="Nível de cuidado"
              value={safety.strictness}
              onChange={(strictness) => setSafety((v) => ({ ...v, strictness }))}
              options={[
                { value: "standard", label: "Padrão" },
                { value: "strict", label: "Rigoroso" },
              ]}
            />
          )}
        </Field>

        <Field label="Palavras bloqueadas" optional hint="O apresentador nunca fala essas palavras, e mensagens do chat com elas são ignoradas. Aperte Enter depois de cada uma.">
          {(props) => <Chips {...props} values={safety.blocklist} onChange={(blocklist) => setSafety((v) => ({ ...v, blocklist }))} max={500} maxLength={60} placeholder="Adicione uma palavra ou frase" />}
        </Field>

        <Field label="Assuntos a evitar" optional hint="O apresentador foge desses assuntos, mesmo quando perguntam. Exemplo: política, outros streamers, meu nome real.">
          {(props) => <Chips {...props} values={safety.avoidTopics} onChange={(avoidTopics) => setSafety((v) => ({ ...v, avoidTopics }))} max={30} maxLength={60} placeholder="Adicione um assunto" />}
        </Field>
      </div>

      <Panel className={s.blocked} aria-labelledby="blocked-heading">
        <div className={p.sectionHead}>
          <h2 id="blocked-heading">Bloqueado antes de ser dito</h2>
          <p>Falas barradas pela checagem de segurança, das mais novas para as mais antigas. Ninguém ouviu.</p>
        </div>
        {blocked.loading ? (
          <Skeleton height={80} />
        ) : blocked.lines.length === 0 ? (
          <p className={s.none}>Nada bloqueado recentemente.</p>
        ) : (
          <ol className={s.blockedList}>
            {blocked.lines.map((line) => (
              <li key={line.key}>
                <span className={s.when}>{time(line.at)}</span>
                <del className={s.text}>{line.text}</del>
                {line.reason && <span className={s.reason}>{blockReason(line.reason)}</span>}
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}

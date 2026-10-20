import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { LineChart } from "../../components/LineChart";
import { count, dateTime, duration, lift, time, usd } from "../../lib/format";
import { useAudience, useSegmentScores, useSession, useSessions } from "../../lib/query";
import type { Audience, SegmentScore, SessionSummary } from "../../lib/types";
import { Empty, Panel, Skeleton } from "../../ui/Display";
import { cx } from "../../ui/cx";
import p from "../page.module.css";
import { useHost } from "./context";
import s from "./analytics.module.css";

function lengthOf(session: SessionSummary): string {
  return duration((session.endedAt ? Date.parse(session.endedAt) : Date.now()) - Date.parse(session.startedAt));
}

function SessionDetail({ channelId, session }: { channelId: string; session: SessionSummary }) {
  const { data, isPending } = useSession(channelId, session.id);
  const points = useMemo(() => (data?.samples ?? []).map((s) => ({ t: Date.parse(s.minute), v: s.viewers })), [data]);
  const spoken = data?.lines.filter((l) => l.status === "spoken").length ?? session.spokenLines;
  return (
    <Panel className={s.detail} aria-labelledby="detail-heading">
      <div className={s.detailHead}>
        <h2 id="detail-heading">{dateTime(session.startedAt)}</h2>
        <span className={s.dim}>{session.endedAt ? lengthOf(session) : `Ao vivo há ${lengthOf(session)}`}</span>
      </div>
      <dl className={s.stats}>
        <div>
          <dt>Pico de espectadores</dt>
          <dd>{count(session.peakViewers)}</dd>
        </div>
        <div>
          <dt>Diamantes</dt>
          <dd className="money">✦ {count(session.diamonds)}</dd>
        </div>
        <div>
          <dt>Mensagens no chat</dt>
          <dd>{count(session.messages)}</dd>
        </div>
        <div>
          <dt>Novos seguidores</dt>
          <dd>{count(session.follows)}</dd>
        </div>
        <div>
          <dt>Falas ditas</dt>
          <dd>{count(spoken)}</dd>
        </div>
        <div>
          <dt>Bloqueadas</dt>
          <dd>{count(session.blockedLines)}</dd>
        </div>
        <div>
          <dt>Custo de IA</dt>
          <dd>{usd(session.costUsd)}</dd>
        </div>
      </dl>
      {data?.session.summary && (
        <p className={s.summary}>
          <span className={s.dim}>O que o apresentador lembra: </span>
          {data.session.summary}
        </p>
      )}
      {isPending ? (
        <Skeleton height={220} />
      ) : (
        <LineChart
          points={points}
          label={`Espectadores ao longo do tempo, com pico de ${session.peakViewers}`}
          formatX={(t) => time(t)}
          formatY={(v) => count(Math.round(v))}
        />
      )}
      {data && data.lines.length > 0 && (
        <details className={s.transcript}>
          <summary>Tudo o que o apresentador falou ({count(data.lines.length)} falas)</summary>
          <ol>
            {data.lines.map((line, i) => (
              <li key={i} className={cx(line.status === "blocked" && s.blockedLine)}>
                <span className={s.when}>{time(line.at)}</span>
                {line.status === "blocked" ? <del>{line.text}</del> : line.text}
              </li>
            ))}
          </ol>
        </details>
      )}
    </Panel>
  );
}

function People({ title, people, metric }: { title: string; people: Audience["supporters"]; metric: "diamonds" | "visits" }) {
  return (
    <div className={s.people}>
      <h3>{title}</h3>
      {people.length === 0 ? (
        <p className={s.dim}>Ninguém ainda.</p>
      ) : (
        <ol>
          {people.map((person) => (
            <li key={person.id}>
              <span className={s.person}>{person.nickname || person.handle}</span>
              <span className={metric === "diamonds" ? "money" : s.dim}>{metric === "diamonds" ? `✦ ${count(person.diamonds)}` : `${count(person.visits)} visitas`}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const KIND_LABELS: Record<SegmentScore["kind"], string> = { talk: "Conversa", game: "Jogo", segment: "Seu quadro" };

function Lift({ value }: { value: number }) {
  return <span className={value >= 0.15 ? s.up : value <= -0.15 ? s.down : s.dim}>{lift(value)}</span>;
}

/** Which segments pull viewers, likes and gifts (ADR-0043), best first: the show leans toward the top ones. */
function Segments({ channelId, name }: { channelId: string; name: string }) {
  const { data, isPending } = useSegmentScores(channelId);
  return (
    <section aria-labelledby="segments-heading" className={p.section}>
      <div className={p.sectionHead}>
        <h2 id="segments-heading">Quadros que mais rendem</h2>
        <p>
          Cada quadro comparado com o resto da mesma live. {name} dá mais tempo aos quadros que funcionam e, no roteiro automático, escolhe esses mais vezes.
        </p>
      </div>
      {isPending ? (
        <Skeleton height={160} />
      ) : !data?.length ? (
        <p className={s.dim}>Aparece depois de alguns quadros numa live de verdade no TikTok. O modo de treino não conta.</p>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Quadro</th>
                <th scope="col">Vezes</th>
                <th scope="col">Espectadores</th>
                <th scope="col">Curtidas</th>
                <th scope="col">Diamantes</th>
                <th scope="col">Destaque</th>
              </tr>
            </thead>
            <tbody>
              {data.map((segment) => (
                <tr key={segment.key}>
                  <th scope="row">
                    {segment.title} <span className={s.dim}>· {KIND_LABELS[segment.kind]}</span>
                  </th>
                  <td>{count(segment.plays)}</td>
                  <td>
                    <Lift value={segment.viewers} />
                  </td>
                  <td>
                    <Lift value={segment.likes} />
                  </td>
                  <td>
                    <Lift value={segment.diamonds} />
                  </td>
                  <td>{segment.focus >= 1.4 ? <span className={s.up}>Em alta</span> : segment.focus <= 0.7 ? <span className={s.down}>Em baixa</span> : <span className={s.dim}>Normal</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Analytics() {
  const { channel } = useHost();
  const sessions = useSessions(channel.id);
  const audience = useAudience(channel.id);
  const [params, setParams] = useSearchParams();
  const list = sessions.data ?? [];
  const selected = list.find((s) => s.id === params.get("stream")) ?? list[0];

  if (sessions.isPending) return <Skeleton height={300} />;
  if (list.length === 0) {
    return (
      <Empty title="Nenhuma live ainda">
        <p>Depois da primeira live de {channel.name}, você vê aqui os espectadores ao longo do tempo, presentes, seguidores e tudo o que foi dito.</p>
      </Empty>
    );
  }

  return (
    <div className={s.layout}>
      <div className={s.main}>
        {selected && <SessionDetail channelId={channel.id} session={selected} />}

        <section aria-labelledby="streams-heading" className={p.section}>
          <h2 id="streams-heading">Lives</h2>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Início</th>
                  <th scope="col">Duração</th>
                  <th scope="col">Pico</th>
                  <th scope="col">Diamantes</th>
                  <th scope="col">Mensagens</th>
                  <th scope="col">Custo de IA</th>
                </tr>
              </thead>
              <tbody>
                {list.map((session) => (
                  <tr key={session.id} aria-selected={session.id === selected?.id} className={cx(session.id === selected?.id && s.selected)}>
                    <th scope="row">
                      <button type="button" className={s.rowButton} onClick={() => setParams({ stream: session.id }, { replace: true })}>
                        {dateTime(session.startedAt)}
                      </button>
                    </th>
                    <td>{session.endedAt ? lengthOf(session) : "Ao vivo agora"}</td>
                    <td>{count(session.peakViewers)}</td>
                    <td className="money">✦ {count(session.diamonds)}</td>
                    <td>{count(session.messages)}</td>
                    <td>{usd(session.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <Segments channelId={channel.id} name={channel.persona.name} />
      </div>

      <Panel as="aside" className={s.audience} aria-labelledby="audience-heading">
        <div className={p.sectionHead}>
          <h2 id="audience-heading">Público</h2>
          {audience.data && <p>{channel.name} lembra o nome de {count(audience.data.remembered)} espectadores.</p>}
        </div>
        {audience.isPending ? (
          <Skeleton height={160} />
        ) : audience.data ? (
          <>
            <People title="Quem mais apoia" people={audience.data.supporters} metric="diamonds" />
            <People title="Frequentes" people={audience.data.regulars} metric="visits" />
          </>
        ) : null}
      </Panel>
    </div>
  );
}

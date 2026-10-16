import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { LineChart } from "../../components/LineChart";
import { count, dateTime, duration, time, usd } from "../../lib/format";
import { useAudience, useSession, useSessions } from "../../lib/query";
import type { Audience, SessionSummary } from "../../lib/types";
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
        <span className={s.dim}>{session.endedAt ? lengthOf(session) : `Live for ${lengthOf(session)}`}</span>
      </div>
      <dl className={s.stats}>
        <div>
          <dt>Peak viewers</dt>
          <dd>{count(session.peakViewers)}</dd>
        </div>
        <div>
          <dt>Diamonds</dt>
          <dd className="money">✦ {count(session.diamonds)}</dd>
        </div>
        <div>
          <dt>Chat messages</dt>
          <dd>{count(session.messages)}</dd>
        </div>
        <div>
          <dt>New followers</dt>
          <dd>{count(session.follows)}</dd>
        </div>
        <div>
          <dt>Lines spoken</dt>
          <dd>{count(spoken)}</dd>
        </div>
        <div>
          <dt>Blocked</dt>
          <dd>{count(session.blockedLines)}</dd>
        </div>
        <div>
          <dt>AI cost</dt>
          <dd>{usd(session.costUsd)}</dd>
        </div>
      </dl>
      {isPending ? (
        <Skeleton height={220} />
      ) : (
        <LineChart
          points={points}
          label={`Viewers over time, peaking at ${session.peakViewers}`}
          formatX={(t) => time(t)}
          formatY={(v) => count(Math.round(v))}
        />
      )}
      {data && data.lines.length > 0 && (
        <details className={s.transcript}>
          <summary>Everything the host said ({count(data.lines.length)} lines)</summary>
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
        <p className={s.dim}>Nobody yet.</p>
      ) : (
        <ol>
          {people.map((person) => (
            <li key={person.id}>
              <span className={s.person}>{person.nickname || person.handle}</span>
              <span className={metric === "diamonds" ? "money" : s.dim}>{metric === "diamonds" ? `✦ ${count(person.diamonds)}` : `${count(person.visits)} visits`}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
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
      <Empty title="No streams yet">
        <p>After {channel.name}'s first stream, you'll see viewers over time, gifts, followers and everything it said.</p>
      </Empty>
    );
  }

  return (
    <div className={s.layout}>
      <div className={s.main}>
        {selected && <SessionDetail channelId={channel.id} session={selected} />}

        <section aria-labelledby="streams-heading" className={p.section}>
          <h2 id="streams-heading">Streams</h2>
          <div className={s.tableWrap}>
            <table className={s.table}>
              <thead>
                <tr>
                  <th scope="col">Started</th>
                  <th scope="col">Length</th>
                  <th scope="col">Peak</th>
                  <th scope="col">Diamonds</th>
                  <th scope="col">Messages</th>
                  <th scope="col">AI cost</th>
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
                    <td>{session.endedAt ? lengthOf(session) : "Live now"}</td>
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
      </div>

      <Panel as="aside" className={s.audience} aria-labelledby="audience-heading">
        <div className={p.sectionHead}>
          <h2 id="audience-heading">Audience</h2>
          {audience.data && <p>{channel.name} remembers {count(audience.data.remembered)} viewers by name.</p>}
        </div>
        {audience.isPending ? (
          <Skeleton height={160} />
        ) : audience.data ? (
          <>
            <People title="Top supporters" people={audience.data.supporters} metric="diamonds" />
            <People title="Regulars" people={audience.data.regulars} metric="visits" />
          </>
        ) : null}
      </Panel>
    </div>
  );
}

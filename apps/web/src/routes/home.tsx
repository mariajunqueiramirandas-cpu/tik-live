import type { ChannelListItem } from "@tik-live/shared";
import { Plus } from "lucide-react";
import { Link } from "react-router";
import { HostSwatch } from "../components/Brand";
import { Sparkline } from "../components/Sparkline";
import { ago, count, duration } from "../lib/format";
import { prefetchProps } from "../lib/prefetch";
import { useBilling, useChannels } from "../lib/query";
import { ButtonLink } from "../ui/Button";
import { Empty, Skeleton, Status } from "../ui/Display";
import p from "./page.module.css";
import s from "./home.module.css";

function HostRow({ channel }: { channel: ChannelListItem }) {
  const live = channel.runtime.status === "live";
  const last = channel.lastStream;
  const to = `/app/hosts/${channel.id}`;
  return (
    <li className={s.row}>
      <Link to={to} className={s.rowLink} viewTransition {...prefetchProps(to)}>
        <HostSwatch look={channel.persona.look} size={40} />
        <span className={s.identity}>
          <span className={s.name}>{channel.name}</span>
          <span className={s.where}>{channel.source === "tiktok" && channel.tiktokUsername ? `@${channel.tiktokUsername}` : "Practice mode"}</span>
        </span>
      </Link>
      <span className={s.status}>
        <Status status={channel.runtime.status} />
        {live && <span className={s.watching}>{count(channel.runtime.viewers)} watching</span>}
      </span>
      <span className={s.trend}>
        {last ? (
          <>
            <Sparkline values={last.viewers} label={`Last stream peaked at ${last.peakViewers} viewers`} />
            <span className={s.trendText}>
              <span>Peak {count(last.peakViewers)}</span>
              <span className={s.dim}>{live ? "now" : ago(last.endedAt ?? last.startedAt)}</span>
            </span>
          </>
        ) : (
          <span className={s.dim}>No streams yet</span>
        )}
      </span>
      <span className={s.rowActions}>
        <ButtonLink to={to} size="sm" variant={live ? "secondary" : "ghost"} {...prefetchProps(to)}>
          {live ? "Open studio" : "Studio"}
        </ButtonLink>
      </span>
    </li>
  );
}

function UsageMeter() {
  const { data } = useBilling();
  if (!data) return null;
  const { liveSeconds, liveHoursLimit } = data.usage;
  const used = liveSeconds / 3600;
  const pct = liveHoursLimit ? Math.min(100, (used / liveHoursLimit) * 100) : 0;
  return (
    <div className={s.usage}>
      <div className={s.usageText}>
        <span>Live this month</span>
        <span>
          <strong>{duration(liveSeconds * 1000)}</strong>
          {liveHoursLimit !== null && <span className={s.dim}> of {liveHoursLimit} h on {data.plan.name}</span>}
        </span>
      </div>
      {liveHoursLimit !== null && (
        <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={liveHoursLimit} aria-valuenow={Math.round(used * 10) / 10} aria-label="Live hours used this month">
          <span style={{ width: `${pct}%` }} data-high={pct > 85 || undefined} />
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const { data: channels, isPending } = useChannels();
  const liveCount = channels?.filter((c) => c.runtime.status === "live").length ?? 0;
  return (
    <div className={p.page}>
      <header className={p.header}>
        <div>
          <h1>Your hosts</h1>
          <p className={p.lede}>
            {liveCount > 0 ? `${liveCount === 1 ? "One host is" : `${liveCount} hosts are`} live right now.` : "Each host is a character that runs a TikTok LIVE on its own."}
          </p>
        </div>
        <ButtonLink to="/app/new" variant="primary" icon={<Plus aria-hidden />} {...prefetchProps("/app/new")}>
          New host
        </ButtonLink>
      </header>

      {isPending ? (
        <div className={s.list}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
      ) : channels && channels.length > 0 ? (
        <ul role="list" className={s.list} aria-label="Hosts">
          {channels.map((channel) => (
            <HostRow key={channel.id} channel={channel} />
          ))}
        </ul>
      ) : (
        <Empty title="Create your first host" action={<ButtonLink to="/app/new" variant="primary" icon={<Plus aria-hidden />}>Create a host</ButtonLink>}>
          <p>Pick a character, give it a name, and try it in practice mode before it ever goes live. It takes about a minute.</p>
        </Empty>
      )}

      <UsageMeter />
    </div>
  );
}

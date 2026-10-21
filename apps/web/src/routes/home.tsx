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
    <li className={s.row} data-live={live || undefined} style={{ "--host-a": channel.persona.look.primary, "--host-b": channel.persona.look.secondary } as React.CSSProperties}>
      <Link to={to} className={s.rowLink} viewTransition {...prefetchProps(to)}>
        <span className={s.avatar}>
          <HostSwatch look={channel.persona.look} size={44} />
        </span>
        <span className={s.identity}>
          <span className={s.name}>{channel.name}</span>
          <span className={s.where}>{channel.source === "tiktok" && channel.tiktokUsername ? `@${channel.tiktokUsername}` : "Modo de treino"}</span>
        </span>
      </Link>
      <span className={s.status}>
        <Status status={channel.runtime.status} />
        {live && <span className={s.watching}>{count(channel.runtime.viewers)} assistindo</span>}
      </span>
      <span className={s.trend}>
        {last ? (
          <>
            <Sparkline values={last.viewers} width={112} height={36} label={`A última live teve pico de ${last.peakViewers} espectadores`} />
            <span className={s.trendText}>
              <span>
                Pico <strong>{count(last.peakViewers)}</strong>
              </span>
              <span className={s.dim}>{live ? "agora" : ago(last.endedAt ?? last.startedAt)}</span>
            </span>
          </>
        ) : (
          <span className={s.dim}>Nenhuma live ainda</span>
        )}
      </span>
      <span className={s.rowActions}>
        <ButtonLink to={to} size="sm" variant={live ? "secondary" : "ghost"} {...prefetchProps(to)}>
          {live ? "Abrir estúdio" : "Estúdio"}
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
        <span className={s.usageLabel}>Ao vivo neste mês</span>
        <span>
          <strong className={s.usageValue}>{duration(liveSeconds * 1000)}</strong>
          {liveHoursLimit !== null && <span className={s.dim}> de {liveHoursLimit} h no plano {data.plan.name}</span>}
        </span>
        <Link to="/app/billing" className={s.usageLink} {...prefetchProps("/app/billing")}>
          Ver planos
        </Link>
      </div>
      {liveHoursLimit !== null && (
        <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={liveHoursLimit} aria-valuenow={Math.round(used * 10) / 10} aria-label="Horas ao vivo usadas neste mês">
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
          <h1>Seus apresentadores</h1>
          <p className={p.lede}>
            {liveCount > 0 ? `${liveCount === 1 ? "Um apresentador está" : `${liveCount} apresentadores estão`} ao vivo agora.` : "Cada apresentador é um personagem que comanda uma TikTok LIVE sozinho."}
          </p>
        </div>
        <ButtonLink to="/app/new" variant="primary" icon={<Plus aria-hidden />} {...prefetchProps("/app/new")}>
          Novo apresentador
        </ButtonLink>
      </header>

      {isPending ? (
        <div className={s.list}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} height={72} />
          ))}
        </div>
      ) : channels && channels.length > 0 ? (
        <ul role="list" className={s.list} aria-label="Apresentadores">
          {channels.map((channel) => (
            <HostRow key={channel.id} channel={channel} />
          ))}
        </ul>
      ) : (
        <Empty title="Crie seu primeiro apresentador" action={<ButtonLink to="/app/new" variant="primary" icon={<Plus aria-hidden />}>Criar apresentador</ButtonLink>}>
          <p>Escolha um personagem, dê um nome e teste no modo de treino antes de entrar ao vivo. Leva cerca de um minuto.</p>
        </Empty>
      )}

      <UsageMeter />
    </div>
  );
}

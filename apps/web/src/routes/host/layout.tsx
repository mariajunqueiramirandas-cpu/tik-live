import { Copy, MoreHorizontal, Play, Square, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router";
import { HostSwatch } from "../../components/Brand";
import { clock, count } from "../../lib/format";
import { prefetchProps } from "../../lib/prefetch";
import { useChannel, useDeleteChannel, useRunChannel } from "../../lib/query";
import { useStudio, useStudioStore } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { Skeleton, Status } from "../../ui/Display";
import { Confirm, Menu } from "../../ui/Overlay";
import { cx } from "../../ui/cx";
import { toast } from "../../ui/toast-store";
import type { HostContext } from "./context";
import s from "./host.module.css";

const TABS = [
  { to: "", label: "Estúdio", end: true },
  { to: "character", label: "Personagem" },
  { to: "safety", label: "Segurança" },
  { to: "setup", label: "Configuração" },
  { to: "analytics", label: "Desempenho" },
];

function Uptime({ seconds }: { seconds: number }) {
  const [base] = useState(() => ({ seconds, at: Date.now() }));
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className={s.uptime}>{clock(base.seconds + (Date.now() - base.at) / 1000)}</span>;
}

export default function HostLayout() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { data: channel } = useChannel(id);
  const store = useStudioStore(id);
  const snapshot = useStudio(store, (st) => st.snapshot);
  const run = useRunChannel(id);
  const remove = useDeleteChannel();
  const [confirmDelete, setConfirmDelete] = useState(false);

  if (!channel) {
    return (
      <div className={s.host}>
        <Skeleton height={48} width={280} />
      </div>
    );
  }

  const pendingStatus = run.isPending ? channel.runtime.status : null;
  const status = pendingStatus ?? snapshot?.status ?? channel.runtime.status;
  const onAir = status !== "stopped" && status !== "failed";
  const context: HostContext = { channel, store, status };
  const base = `/app/hosts/${channel.id}`;

  return (
    <div className={s.host}>
      <header className={s.header}>
        <div className={s.identity}>
          <HostSwatch look={channel.persona.look} size={48} />
          <div className={s.titles}>
            <h1 className={s.name}>{channel.name}</h1>
            <div className={s.meta}>
              <Status status={status} />
              {status === "live" && snapshot && (
                <>
                  <Uptime key={snapshot.session?.id ?? "x"} seconds={snapshot.stats.uptimeSec} />
                  <span>{count(snapshot.stats.viewers)} assistindo</span>
                  {snapshot.stats.diamonds > 0 && <span className="money">✦ {count(snapshot.stats.diamonds)}</span>}
                </>
              )}
              {status === "failed" && <span className={s.detail}>{snapshot?.detail ?? channel.runtime.detail}</span>}
              <span className={s.detail}>{channel.source === "tiktok" && channel.tiktokUsername ? `@${channel.tiktokUsername}` : "Modo de treino"}</span>
            </div>
          </div>
        </div>
        <div className={s.actions}>
          {onAir ? (
            <Button variant="quietDanger" icon={<Square aria-hidden />} busy={run.isPending} onClick={() => run.mutate("stop")}>
              Parar o apresentador
            </Button>
          ) : (
            <Button variant="primary" icon={<Play aria-hidden />} busy={run.isPending} onClick={() => run.mutate("start")}>
              Entrar ao vivo
            </Button>
          )}
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button iconOnly icon={<MoreHorizontal aria-hidden />}>
                Mais ações
              </Button>
            </Menu.Trigger>
            <Menu.Content>
              <Menu.Item
                icon={<Copy aria-hidden />}
                onSelect={() => {
                  void navigator.clipboard.writeText(channel.stageUrl).then(
                    () => toast.success("Link do palco copiado", "Cole numa fonte de Navegador no OBS."),
                    () => toast.error("Não deu para copiar o link"),
                  );
                }}
              >
                Copiar link do palco
              </Menu.Item>
              <Menu.Separator />
              <Menu.Item danger icon={<Trash2 aria-hidden />} onSelect={() => setConfirmDelete(true)}>
                Excluir apresentador
              </Menu.Item>
            </Menu.Content>
          </Menu.Root>
        </div>
      </header>

      <nav className={s.tabs} aria-label={`Seções de ${channel.name}`}>
        {TABS.map((tab) => {
          const to = tab.to ? `${base}/${tab.to}` : base;
          return (
            <NavLink key={tab.label} to={to} end={tab.end} className={({ isActive }) => cx(s.tab, isActive && s.tabActive)} viewTransition {...prefetchProps(to)}>
              {tab.label}
            </NavLink>
          );
        })}
      </nav>

      <Outlet context={context} />

      <Confirm
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Excluir ${channel.name}?`}
        description="O apresentador, a memória dos espectadores, as transcrições e o histórico de lives serão excluídos. O link do palco para de funcionar. Não dá para desfazer."
        confirmLabel="Excluir apresentador"
        danger
        onConfirm={async () => {
          await remove.mutateAsync(channel.id);
          toast.info(`Apresentador ${channel.name} excluído`);
          void navigate("/app", { replace: true });
        }}
      />
    </div>
  );
}

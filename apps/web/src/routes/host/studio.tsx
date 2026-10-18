import { Play, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { useRunChannel } from "../../lib/query";
import { useStudio } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Display";
import { toast } from "../../ui/toast-store";
import { Controls } from "./Controls";
import { Health } from "./Health";
import { Room } from "./Room";
import { StageMonitor } from "./StageMonitor";
import { useHost } from "./context";
import s from "./studio.module.css";

function OffAir() {
  const { channel, store } = useHost();
  const run = useRunChannel(channel.id);
  const snapshot = useStudio(store, (st) => st.snapshot);
  const obs = (snapshot?.health.stages.program ?? 0) + (snapshot?.health.stages.broadcast ?? 0) > 0;
  const tiktok = channel.source === "tiktok";
  return (
    <aside className={s.controls} aria-label="Entrar ao vivo">
      <div className={s.offAir}>
        <h2>{channel.name} está fora do ar</h2>
        <p className={s.dim}>
          {tiktok
            ? `Quando você entrar ao vivo, ${channel.name} espera @${channel.tiktokUsername} começar uma TikTok LIVE e aí assume a apresentação.`
            : `No modo de treino, ${channel.name} apresenta para uma plateia simulada. Nada vai para o TikTok.`}
        </p>
        <ul role="list" className={s.checklist}>
          <li data-done={tiktok ? Boolean(channel.tiktokUsername) : true}>{tiktok ? `Escutando @${channel.tiktokUsername}` : "Modo de treino, sem precisar do TikTok"}</li>
          <li data-done={obs}>
            {obs ? "O palco está aberto no OBS" : (
              <>
                Palco ainda fora do OBS. <Link to={`/app/hosts/${channel.id}/setup`}>Configurar</Link>
              </>
            )}
          </li>
        </ul>
        <Button variant="primary" size="lg" icon={<Play aria-hidden />} busy={run.isPending} onClick={() => run.mutate("start")}>
          Entrar ao vivo
        </Button>
      </div>
    </aside>
  );
}

/** Reloads the stage page in OBS: a stuck browser source, or a new look that didn't come through. */
function ReloadObs({ onAir }: { onAir: boolean }) {
  const { store } = useHost();
  const sources = useStudio(store, (st) => st.snapshot?.health.stages.program ?? 0);
  const connected = useStudio(store, (st) => st.connection === "open");
  const [busy, setBusy] = useState(false);
  const reload = async () => {
    if (onAir && !window.confirm("Recarregar o palco no OBS? A tela pisca por um instante e a fala atual é cortada.")) return;
    setBusy(true);
    const result = await store.command({ kind: "reload_stage" });
    setBusy(false);
    if (result.ok) toast.success(sources === 1 ? "Palco recarregado no OBS" : `Palco recarregado em ${sources} fontes do OBS`);
    else toast.error("Não deu para recarregar o palco", new Error(result.error ?? "Tente de novo."));
  };
  return (
    <Button
      size="sm"
      variant="ghost"
      className={s.reloadObs}
      icon={<RefreshCw aria-hidden />}
      busy={busy}
      disabled={!connected || sources === 0}
      title={sources === 0 ? "Nenhum palco aberto no OBS agora" : undefined}
      onClick={reload}
    >
      Recarregar palco no OBS
    </Button>
  );
}

export default function Studio() {
  const { channel, store, status } = useHost();
  const snapshot = useStudio(store, (st) => st.snapshot);
  const connection = useStudio(store, (st) => st.connection);
  const notices = useStudio(store, (st) => st.notices);
  const onAir = status !== "stopped" && status !== "failed" && status !== "stopping";

  return (
    <div className={s.studio}>
      {(connection === "reconnecting" || notices.length > 0 || status === "failed") && (
        <div className={s.banners}>
          {connection === "reconnecting" && (
            <Banner tone="warn" title="Reconectando ao apresentador">
              A live continua. Os controles voltam assim que a conexão voltar.
            </Banner>
          )}
          {status === "failed" && (
            <Banner tone="error" title={`${channel.name} parou de repente`}>
              {snapshot?.detail ?? channel.runtime.detail} Reinicia sozinho em instantes, ou aperte Entrar ao vivo para tentar agora.
            </Banner>
          )}
          {notices.map((notice) => (
            <Banner
              key={notice.id}
              tone={notice.level === "error" ? "error" : notice.level === "warn" ? "warn" : "info"}
              title={notice.message}
              action={
                <Button size="sm" variant="ghost" onClick={() => store.dismissNotice(notice.id)}>
                  Fechar
                </Button>
              }
            />
          ))}
        </div>
      )}

      <Health snapshot={snapshot} onAir={onAir} />

      <div className={s.grid}>
        <div className={s.stageCol}>
          <StageMonitor stageUrl={channel.stageUrl} name={channel.name} />
          <ReloadObs onAir={onAir} />
        </div>
        <Room store={store} host={channel.name} />
        {onAir ? <Controls store={store} onAir={onAir} /> : <OffAir />}
      </div>
    </div>
  );
}

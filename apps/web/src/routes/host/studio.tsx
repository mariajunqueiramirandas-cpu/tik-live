import { Play } from "lucide-react";
import { Link } from "react-router";
import { useRunChannel } from "../../lib/query";
import { useStudio } from "../../lib/studio";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Display";
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
        </div>
        <Room store={store} host={channel.name} />
        {onAir ? <Controls store={store} onAir={onAir} /> : <OffAir />}
      </div>
    </div>
  );
}

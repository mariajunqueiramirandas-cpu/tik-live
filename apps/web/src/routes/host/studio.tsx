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
    <aside className={s.controls} aria-label="Go live">
      <div className={s.offAir}>
        <h2>{channel.name} is off air</h2>
        <p className={s.dim}>
          {tiktok
            ? `When you go live, ${channel.name} waits for @${channel.tiktokUsername} to start a TikTok LIVE, then starts hosting.`
            : `In practice mode, ${channel.name} hosts a room of simulated viewers. Nothing goes to TikTok.`}
        </p>
        <ul role="list" className={s.checklist}>
          <li data-done={tiktok ? Boolean(channel.tiktokUsername) : true}>{tiktok ? `Listening to @${channel.tiktokUsername}` : "Practice mode, no TikTok needed"}</li>
          <li data-done={obs}>
            {obs ? "Stage is open in OBS" : (
              <>
                Stage not in OBS yet. <Link to={`/app/hosts/${channel.id}/setup`}>Set up OBS</Link>
              </>
            )}
          </li>
        </ul>
        <Button variant="primary" size="lg" icon={<Play aria-hidden />} busy={run.isPending} onClick={() => run.mutate("start")}>
          Go live
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
            <Banner tone="warn" title="Reconnecting to your host">
              The show keeps running. Controls come back as soon as the connection does.
            </Banner>
          )}
          {status === "failed" && (
            <Banner tone="error" title={`${channel.name} stopped unexpectedly`}>
              {snapshot?.detail ?? channel.runtime.detail} It restarts on its own in a moment, or press Go live to try now.
            </Banner>
          )}
          {notices.map((notice) => (
            <Banner
              key={notice.id}
              tone={notice.level === "error" ? "error" : notice.level === "warn" ? "warn" : "info"}
              title={notice.message}
              action={
                <Button size="sm" variant="ghost" onClick={() => store.dismissNotice(notice.id)}>
                  Dismiss
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

import type { StageConnection, StageEngine } from "@tik-live/engine";
import { Volume2, VolumeX } from "lucide-react";
import { useRef, useState } from "react";
import { EngineCanvas, loadEngine } from "../../components/EngineCanvas";
import { Button } from "../../ui/Button";
import { stageKeyOf } from "./context";
import s from "./studio.module.css";

/**
 * What viewers see, live: the real engine connected to the stage as a
 * preview (it never paces the host). Muted until the creator listens in.
 */
export function StageMonitor({ stageUrl, name }: { stageUrl: string; name: string }) {
  const engine = useRef<StageEngine | null>(null);
  const [listening, setListening] = useState(false);

  const toggle = async () => {
    const audio = engine.current?.audio;
    if (!audio) return;
    if (listening) {
      audio.setMuted(true);
      setListening(false);
    } else {
      await audio.unlock();
      audio.setMuted(false);
      setListening(true);
    }
  };

  return (
    <div className={s.monitor}>
      <EngineCanvas
        mode="preview"
        label={`Live preview of ${name}'s stage`}
        onReady={(created) => {
          engine.current = created;
          let connection: StageConnection | null = null;
          let disposed = false;
          void loadEngine().then(({ connectStage, stageSocketUrl }) => {
            if (disposed) return;
            connection = connectStage({ engine: created, url: stageSocketUrl(location, stageKeyOf(stageUrl), "preview"), role: "preview" });
          });
          return () => {
            disposed = true;
            connection?.close();
            engine.current = null;
            setListening(false);
          };
        }}
      />
      <Button size="sm" variant="ghost" className={s.listen} icon={listening ? <Volume2 aria-hidden /> : <VolumeX aria-hidden />} onClick={toggle} aria-pressed={listening}>
        {listening ? "Listening" : "Listen"}
      </Button>
    </div>
  );
}

import type { EngineMode, StageEngine } from "@tik-live/engine";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import s from "./engine-canvas.module.css";
import { cx } from "../ui/cx";

/** Loads the engine chunk once, on the first screen that needs it. */
let engineModule: Promise<typeof import("@tik-live/engine")> | null = null;
export function loadEngine() {
  engineModule ??= import("@tik-live/engine");
  return engineModule;
}

/**
 * A 9:16 stage canvas running the real engine (ADR-0009). `onReady` gets
 * the engine once it exists; the effect it returns runs on teardown.
 */
export function EngineCanvas({
  mode,
  onReady,
  className,
  style,
  label,
  seed,
}: {
  mode: EngineMode;
  onReady: (engine: StageEngine) => void | (() => void);
  className?: string;
  style?: CSSProperties;
  label: string;
  seed?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let engine: StageEngine | null = null;
    let cleanup: void | (() => void);
    void loadEngine().then(({ createEngine }) => {
      if (disposed || !ref.current) return;
      try {
        engine = createEngine(ref.current, { mode, ...(seed !== undefined ? { seed } : {}) });
        if (engine.failed === "webgl2-unavailable") setFailed("Este navegador não consegue desenhar o palco (o WebGL2 está desligado). Legendas e voz continuam funcionando na live.");
        cleanup = ready.current(engine);
      } catch {
        setFailed("A prévia do palco não abriu neste navegador.");
      }
    });
    return () => {
      disposed = true;
      if (typeof cleanup === "function") cleanup();
      engine?.destroy();
    };
  }, [mode, seed]);

  return (
    <div className={cx(s.frame, className)} style={style}>
      <canvas ref={ref} className={s.canvas} role="img" aria-label={label} />
      {failed && <p className={s.failed}>{failed}</p>}
    </div>
  );
}

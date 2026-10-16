import type { StageEngine } from "@tik-live/engine";
import type { Emotion, Look } from "@tik-live/shared";
import { useEffect, useRef, type CSSProperties } from "react";
import { EngineCanvas, loadEngine } from "./EngineCanvas";

export interface PreviewLine {
  text: string;
  emotion: Emotion;
  /** Change it to replay the same text. */
  nonce: number;
}

/**
 * The engine running locally (no server) for editors: colors morph live and
 * `line` makes the character speak with captions and a moving mouth.
 */
export function CharacterPreview({ name, look, line, style, className }: { name: string; look: Look; line?: PreviewLine | null; style?: CSSProperties; className?: string }) {
  const engine = useRef<StageEngine | null>(null);
  const latest = useRef({ name, look, line });
  latest.current = { name, look, line };

  useEffect(() => {
    engine.current?.setLook(name, look);
  }, [name, look]);

  useEffect(() => {
    if (!line || !engine.current) return;
    void loadEngine().then(({ estimateLineMs }) => {
      engine.current?.apply({ t: "speak", id: `preview-${line.nonce}`, text: line.text, emotion: line.emotion, audioUrl: null, durationMs: estimateLineMs(line.text) });
    });
  }, [line]);

  return (
    <EngineCanvas
      mode="preview"
      className={className}
      style={style}
      label={`Preview of ${name}`}
      onReady={(created) => {
        engine.current = created;
        created.setLook(latest.current.name, latest.current.look);
        return () => {
          engine.current = null;
        };
      }}
    />
  );
}

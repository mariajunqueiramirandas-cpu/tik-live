import type { RuntimeSnapshot } from "@tik-live/shared";
import { cx } from "../../ui/cx";
import s from "./studio.module.css";

type Tone = "ok" | "warn" | "bad" | "off";

function Item({ tone, label, value }: { tone: Tone; label: string; value: string }) {
  return (
    <li className={cx(s.healthItem, s[tone])}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>{label}</span>
      <span className={s.healthValue}>{value}</span>
    </li>
  );
}

const BROADCAST_TEXT = { starting: "Iniciando", live: "Ao vivo", retrying: "Reconectando", failed: "Sem transmissão", stopped: "Desligada" } as const;

/** "4,5" */
const oneDecimal = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function BroadcastItem({ broadcast }: { broadcast: NonNullable<RuntimeSnapshot["health"]["broadcast"]> }) {
  const tone: Tone = broadcast.state === "live" ? "ok" : broadcast.state === "failed" ? "bad" : broadcast.state === "stopped" ? "off" : "warn";
  const value = broadcast.state === "live" && broadcast.bitrateKbps ? `Ao vivo, ${oneDecimal(broadcast.bitrateKbps / 1000)} Mbps` : BROADCAST_TEXT[broadcast.state];
  return (
    <li className={cx(s.healthItem, s[tone])} title={broadcast.detail}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>Transmissão pela nuvem</span>
      <span className={s.healthValue}>{value}</span>
    </li>
  );
}

/** The few signals a creator needs to trust the show is working. */
export function Health({ snapshot, onAir }: { snapshot: RuntimeSnapshot | null; onAir: boolean }) {
  if (!snapshot) return null;
  const { health } = snapshot;
  const onStage = health.stages.program + health.stages.broadcast;
  const engine = health.engine;
  return (
    <ul role="list" className={s.health} aria-label="Saúde da live">
      <Item
        tone={!onAir ? "off" : health.source.connected ? "ok" : "warn"}
        label={health.source.name === "simulator" ? "Plateia simulada" : "TikTok"}
        value={!onAir ? "Desligado" : health.source.connected ? "Conectado" : health.source.detail || "Conectando"}
      />
      <Item
        tone={onStage > 0 ? "ok" : onAir ? "warn" : "off"}
        label="Na live"
        value={health.stages.broadcast > 0 ? "Transmissão pela nuvem" : onStage > 0 ? (onStage === 1 ? "OBS conectado" : `${onStage} fontes no OBS`) : "OBS não conectado"}
      />
      {engine && <Item tone={engine.error ? "bad" : engine.fps >= 24 ? "ok" : "warn"} label="Palco" value={engine.error ? "Erro ao desenhar" : `${Math.round(engine.fps)} fps`} />}
      {health.latency && <Item tone={health.latency.p50 < 4000 ? "ok" : "warn"} label="Tempo de resposta" value={`${oneDecimal(health.latency.p50 / 1000)} s`} />}
      {health.budget.limitTokensPerHour !== null && (
        <Item tone={health.budget.usedPct < 80 ? "ok" : health.budget.usedPct < 100 ? "warn" : "bad"} label="Orçamento de IA nesta hora" value={`${Math.round(health.budget.usedPct)}%`} />
      )}
      {health.broadcast && <BroadcastItem broadcast={health.broadcast} />}
      {snapshot.reactOnly && onAir && <Item tone="warn" label="Modo" value="Só reagindo" />}
    </ul>
  );
}

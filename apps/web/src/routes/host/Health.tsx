import type { RuntimeSnapshot } from "@tik-live/shared";
import { cx } from "../../ui/cx";
import s from "./studio.module.css";

type Tone = "ok" | "warn" | "bad" | "off";

function Item({ tone, label, value, detail }: { tone: Tone; label: string; value: string; detail?: string }) {
  return (
    <li className={cx(s.healthItem, s[tone])}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>{label}</span>
      <span className={s.healthValue}>{value}</span>
      {detail && <span className={s.healthDetail}>{detail}</span>}
    </li>
  );
}

const BROADCAST_TEXT = { starting: "Iniciando", live: "Ao vivo", retrying: "Reconectando", failed: "Sem transmiss\u00e3o", stopped: "Desligada" } as const;

/** "4,5" */
const oneDecimal = (n: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Where the reply time goes: "espera 0,3 s \u00b7 IA 0,9 s \u00b7 voz 0,8 s \u00b7 fala anterior 0,2 s". */
function latencyDetail(stages: NonNullable<NonNullable<RuntimeSnapshot["health"]["latency"]>["stages"]>): string {
  const parts: Array<[string, number]> = [
    ["espera", stages.waitMs],
    ["IA", stages.writeMs],
    ["voz", stages.voiceMs],
    ["fala anterior", stages.queueMs],
  ];
  return parts.map(([label, ms]) => `${label} ${oneDecimal(ms / 1000)} s`).join(" \u00b7 ");
}

function BroadcastItem({ broadcast }: { broadcast: NonNullable<RuntimeSnapshot["health"]["broadcast"]> }) {
  const tone: Tone = broadcast.state === "live" ? "ok" : broadcast.state === "failed" ? "bad" : broadcast.state === "stopped" ? "off" : "warn";
  const value = broadcast.state === "live" && broadcast.bitrateKbps ? `Ao vivo, ${oneDecimal(broadcast.bitrateKbps / 1000)} Mbps` : BROADCAST_TEXT[broadcast.state];
  return (
    <li className={cx(s.healthItem, s[tone])} title={broadcast.detail}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>Transmiss\u00e3o pela nuvem</span>
      <span className={s.healthValue}>{value}</span>
    </li>
  );
}

function LiveStudioItem({ liveStudio }: { liveStudio: NonNullable<RuntimeSnapshot["health"]["liveStudio"]> }) {
  const tone: Tone = liveStudio.state === "live" ? "ok" : liveStudio.state === "failed" ? "bad" : liveStudio.state === "stopped" ? "off" : "warn";
  const value = BROADCAST_TEXT[liveStudio.state];
  return (
    <li className={cx(s.healthItem, s[tone])} title={liveStudio.detail}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>TikTok LIVE Studio</span>
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
    <ul role="list" className={s.health} aria-label="Sa\u00fade da live">
      <Item
        tone={!onAir ? "off" : health.source.connected ? "ok" : "warn"}
        label={health.source.name === "simulator" ? "Plateia simulada" : "TikTok"}
        value={!onAir ? "Desligado" : health.source.connected ? "Conectado" : health.source.detail || "Conectando"}
      />
      <Item
        tone={onStage > 0 ? "ok" : onAir ? "warn" : "off"}
        label="Na live"
        value={health.stages.broadcast > 0 ? "Transmiss\u00e3o pela nuvem" : onStage > 0 ? (onStage === 1 ? "OBS conectado" : `${onStage} fontes no OBS`) : "OBS n\u00e3o conectado"}
      />
      {engine && <Item tone={engine.error ? "bad" : engine.fps >= 24 ? "ok" : "warn"} label="Palco" value={engine.error ? "Erro ao desenhar" : `${Math.round(engine.fps)} fps`} />}
      {health.latency && (
        <Item
          tone={health.latency.p50 < 4000 ? "ok" : "warn"}
          label="Tempo de resposta"
          value={`${oneDecimal(health.latency.p50 / 1000)} s`}
          {...(health.latency.stages ? { detail: latencyDetail(health.latency.stages) } : {})}
        />
      )}
      {health.brain.context && onAir && (
        <Item tone={health.brain.context.cachedPct >= 50 ? "ok" : "warn"} label="Mem\u00f3ria da live" value={`${health.brain.context.cachedPct}% reaproveitado`} />
      )}
      {health.budget.limitTokensPerHour !== null && (
        <Item tone={health.budget.usedPct < 80 ? "ok" : health.budget.usedPct < 100 ? "warn" : "bad"} label="Or\u00e7amento de IA nesta hora" value={`${Math.round(health.budget.usedPct)}%`} />
      )}
      {health.liveStudio && <LiveStudioItem liveStudio={health.liveStudio} />}
      {health.broadcast && <BroadcastItem broadcast={health.broadcast} />}
      {snapshot.reactOnly && onAir && <Item tone="warn" label="Modo" value="S\u00f3 reagindo" />}
    </ul>
  );
}

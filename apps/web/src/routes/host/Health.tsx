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

const BROADCAST_TEXT = { starting: "Starting", live: "Live", retrying: "Reconnecting", failed: "Not streaming", stopped: "Off" } as const;

function BroadcastItem({ broadcast }: { broadcast: NonNullable<RuntimeSnapshot["health"]["broadcast"]> }) {
  const tone: Tone = broadcast.state === "live" ? "ok" : broadcast.state === "failed" ? "bad" : broadcast.state === "stopped" ? "off" : "warn";
  const value = broadcast.state === "live" && broadcast.bitrateKbps ? `Live, ${(broadcast.bitrateKbps / 1000).toFixed(1)} Mbps` : BROADCAST_TEXT[broadcast.state];
  return (
    <li className={cx(s.healthItem, s[tone])} title={broadcast.detail}>
      <span className={s.healthDot} aria-hidden />
      <span className={s.healthLabel}>Cloud broadcast</span>
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
    <ul role="list" className={s.health} aria-label="Health">
      <Item
        tone={!onAir ? "off" : health.source.connected ? "ok" : "warn"}
        label={health.source.name === "simulator" ? "Practice viewers" : "TikTok"}
        value={!onAir ? "Off" : health.source.connected ? "Connected" : health.source.detail || "Connecting"}
      />
      <Item
        tone={onStage > 0 ? "ok" : onAir ? "warn" : "off"}
        label="On stream"
        value={health.stages.broadcast > 0 ? "Cloud broadcast" : onStage > 0 ? (onStage === 1 ? "OBS connected" : `${onStage} OBS sources`) : "OBS not connected"}
      />
      {engine && <Item tone={engine.error ? "bad" : engine.fps >= 24 ? "ok" : "warn"} label="Stage" value={engine.error ? "Drawing problem" : `${Math.round(engine.fps)} fps`} />}
      {health.latency && <Item tone={health.latency.p50 < 4000 ? "ok" : "warn"} label="Reply time" value={`${(health.latency.p50 / 1000).toFixed(1)} s`} />}
      {health.budget.limitTokensPerHour !== null && (
        <Item tone={health.budget.usedPct < 80 ? "ok" : health.budget.usedPct < 100 ? "warn" : "bad"} label="AI budget this hour" value={`${Math.round(health.budget.usedPct)}%`} />
      )}
      {health.broadcast && <BroadcastItem broadcast={health.broadcast} />}
      {snapshot.reactOnly && onAir && <Item tone="warn" label="Mode" value="Reacting only" />}
    </ul>
  );
}

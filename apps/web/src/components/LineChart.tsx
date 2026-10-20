import { useEffect, useId, useRef, useState } from "react";
import s from "./line-chart.module.css";

export interface Point {
  t: number;
  v: number;
}

function niceMax(value: number): number {
  if (value <= 5) return 5;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const n = value / magnitude;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * magnitude;
}

/**
 * One series over time, drawn at the container's real width so text never
 * stretches. A summary label describes it for screen readers.
 */
export function LineChart({ points, label, formatX, formatY, height = 220 }: { points: Point[]; label: string; formatX: (t: number) => string; formatY: (v: number) => string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  const fade = `chart-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => entry && setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  if (points.length < 2) return <p className={s.empty}>Ainda não há dados para o gráfico.</p>;

  const pad = { left: 44, right: 12, top: 12, bottom: 28 };
  const w = width - pad.left - pad.right;
  const h = height - pad.top - pad.bottom;
  const t0 = points[0]!.t;
  const t1 = points[points.length - 1]!.t;
  const max = niceMax(Math.max(...points.map((p) => p.v)));
  const x = (t: number) => pad.left + ((t - t0) / Math.max(1, t1 - t0)) * w;
  const y = (v: number) => pad.top + h - (v / max) * h;
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${path}L${x(t1)},${pad.top + h}L${x(t0)},${pad.top + h}Z`;
  const yTicks = [0, max / 2, max];
  const xTicks = [t0, t0 + (t1 - t0) / 2, t1];
  const active = hover === null ? null : points[hover];

  return (
    <div ref={ref} className={s.chart}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const t = t0 + ((e.clientX - rect.left - pad.left) / w) * (t1 - t0);
          let best = 0;
          for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={pad.left + w} y1={y(v)} y2={y(v)} className={s.grid} />
            <text x={pad.left - 8} y={y(v)} className={s.yLabel} dominantBaseline="middle" textAnchor="end">
              {formatY(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={t} x={x(t)} y={height - 8} className={s.xLabel} textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}>
            {formatX(t)}
          </text>
        ))}
        <defs>
          <linearGradient id={fade} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--glow)" stopOpacity="0.2" />
            <stop offset="1" stopColor="var(--glow)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${fade})`} />
        <path d={path} className={s.line} />
        {active && (
          <g>
            <line x1={x(active.t)} x2={x(active.t)} y1={pad.top} y2={pad.top + h} className={s.cursor} />
            <circle cx={x(active.t)} cy={y(active.v)} r={4} className={s.dot} />
          </g>
        )}
      </svg>
      {active && (
        <div className={s.tip} style={{ left: Math.min(width - 140, Math.max(0, x(active.t) - 70)) }} aria-hidden>
          <strong>{formatY(active.v)}</strong> assistindo
          <span>{formatX(active.t)}</span>
        </div>
      )}
    </div>
  );
}

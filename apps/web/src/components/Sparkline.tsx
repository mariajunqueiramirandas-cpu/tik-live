/**
 * A tiny trend line (no axes) for list rows. The label carries the numbers
 * for screen readers; the line is decoration for sighted users.
 */
export function Sparkline({ values, width = 120, height = 32, label }: { values: number[]; width?: number; height?: number; label: string }) {
  if (values.length < 2) {
    return (
      <svg width={width} height={height} role="img" aria-label={label}>
        <line x1="0" x2={width} y1={height - 2} y2={height - 2} stroke="var(--hairline-strong)" strokeDasharray="2 4" />
      </svg>
    );
  }
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => [i * step, height - 3 - (v / max) * (height - 6)] as const);
  const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${width},${height}L0,${height}Z`;
  const last = points[points.length - 1] as readonly [number, number];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={area} fill="var(--glow-soft)" />
      <path d={line} fill="none" stroke="var(--glow)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--glow)" />
    </svg>
  );
}

export function Sparkline({
  points,
  width = 220,
  height = 48,
}: {
  points: (number | null)[];
  width?: number;
  height?: number;
}) {
  const values = points.filter((p): p is number => p !== null);
  if (values.length === 0) {
    return <p className="text-sm text-muted">No score history yet.</p>;
  }
  if (values.length === 1) {
    return (
      <p className="text-sm text-muted">
        1 data point — score {Math.round(values[0]! * 100)}%
      </p>
    );
  }
  const pad = 4;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const coords = points
    .map((p, i) => (p === null ? null : ([pad + i * step, height - pad - p * (height - pad * 2)] as const)))
    .filter((c): c is readonly [number, number] => c !== null);
  const path = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg
      role="img"
      aria-label="Score history"
      viewBox={`0 0 ${width} ${height}`}
      className="h-12 w-full max-w-60"
    >
      <path d={path} fill="none" stroke="#1647a5" strokeWidth="2" />
      {coords.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="2.5" fill="#012970" />
      ))}
    </svg>
  );
}

/** Readiness history chart — sparkline with an optional caption. */
export function ReadinessChart({
  points,
  label,
}: {
  points: (number | null)[];
  label?: string;
}) {
  return (
    <div>
      {label && <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{label}</p>}
      <Sparkline points={points} />
    </div>
  );
}

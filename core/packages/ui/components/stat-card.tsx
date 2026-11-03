/** One figure and what it counts: the value formatted by the caller with Intl, in tabular digits. */
export function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <dl className="grid content-start gap-1 rounded-xl border border-line bg-surface p-4 shadow-xs">
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="text-2xl font-semibold tracking-tight text-ink tabular-nums">{value}</dd>
      {hint ? <dd className="text-xs text-ink-muted">{hint}</dd> : null}
    </dl>
  );
}

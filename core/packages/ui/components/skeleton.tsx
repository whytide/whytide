import { cx } from "./cx.ts";

const SHIMMER =
  "block animate-shimmer rounded-full bg-linear-to-r from-muted via-hover to-muted bg-[length:200%_100%]";

/**
 * Where content is still loading: lines that shimmer, or a table's rows (`shape="table"`), hidden
 * from assistive technology, so a LoadingState beside them says the words.
 */
export function Skeleton({
  lines = 3,
  shape = "lines",
}: {
  lines?: number;
  shape?: "lines" | "table";
}) {
  const each = Array.from({ length: lines }, (_, line) => line);
  if (shape === "table") {
    return (
      <div
        aria-hidden="true"
        className="overflow-hidden rounded-xl border border-line bg-surface shadow-xs"
      >
        <div className="h-10 border-b border-line bg-muted/60" />
        {each.map((line) => (
          <div
            key={line}
            className="flex items-center gap-4 border-b border-line px-4 py-3.5 last:border-b-0"
          >
            <span className={cx(SHIMMER, "size-6 shrink-0")} />
            <span className={cx(SHIMMER, "h-3 w-32 shrink-0")} />
            <span className={cx(SHIMMER, "h-3 flex-1 max-sm:hidden")} />
            <span className={cx(SHIMMER, "h-3 w-16 shrink-0")} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className="grid gap-2.5">
      {each.map((line) => (
        <span key={line} className={cx(SHIMMER, "h-3 last:w-3/5")} />
      ))}
    </div>
  );
}

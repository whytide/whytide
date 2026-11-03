import { cx } from "./cx.ts";

const SIZES = { sm: "size-6 text-2xs", md: "size-7 text-xs", lg: "size-12 text-lg" } as const;

/**
 * A person's initial (or a workspace's, `square`) on the accent's tint, beside the name it stands for:
 * decorative, so the name stays in text. The initial is drawn by CSS from `data-initial`.
 */
export function Avatar(props: { name: string; size?: "sm" | "md" | "lg"; square?: boolean }) {
  const { name, size = "md", square } = props;
  const initial = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span
      aria-hidden="true"
      data-initial={initial}
      className={cx(
        "grid shrink-0 place-items-center bg-accent-soft font-semibold text-accent-ink ring-1 ring-accent/20 ring-inset before:content-[attr(data-initial)]",
        SIZES[size],
        square ? "rounded-lg" : "rounded-full",
      )}
    />
  );
}

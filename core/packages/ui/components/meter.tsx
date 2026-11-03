import { METER_BOX, METER_LEAST_PERCENT } from "./constants.ts";
import { cx } from "./cx.ts";

export type MeterTone = "accent" | "hot" | "warm" | "cool" | "muted" | "danger";
/** One part of a stacked Meter: its value, of the meter's `max`, and its colour. */
export type MeterSegment = { value: number; tone: MeterTone };

const TONES: Record<MeterTone, string> = {
  accent: "fill-accent",
  hot: "fill-hot-dot",
  warm: "fill-warm-dot",
  cool: "fill-cool-dot",
  muted: "fill-line-strong",
  danger: "fill-danger",
};

type Props = { max?: number; size?: "sm" | "md" } & (
  | { value: number; tone?: MeterTone }
  | { segments: readonly MeterSegment[] }
);

/**
 * A share at a glance, as wide as its place: `value` of `max` (100 by default), or `segments` side
 * by side. An SVG, whose widths are attributes, since the content security policy refuses a style.
 * Decorative: the number it stands for stays in text beside it.
 */
export function Meter(props: Props) {
  const { max = 100, size = "sm" } = props;
  const parts = "segments" in props ? props.segments : [{ value: props.value, tone: props.tone }];
  let start = 0;
  const bars = parts.map(({ value, tone = "accent" }) => {
    const share = max > 0 ? Math.min(Math.max(value / max, 0), 1) * 100 : 0;
    const width = Math.min(share > 0 ? Math.max(share, METER_LEAST_PERCENT) : 0, 100 - start);
    const bar = { x: start, width, tone };
    start += width;
    return bar;
  });
  return (
    <svg
      aria-hidden="true"
      viewBox={METER_BOX}
      preserveAspectRatio="none"
      className={cx(
        "block w-full shrink overflow-hidden rounded-full bg-muted",
        size === "md" ? "h-2.5" : "h-1.5",
      )}
    >
      {bars.map(({ x, width, tone }) =>
        width > 0 ? <rect key={x} x={x} width={width} height="1" className={TONES[tone]} /> : null,
      )}
    </svg>
  );
}

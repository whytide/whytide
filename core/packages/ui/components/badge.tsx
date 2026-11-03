import { Flame, type LucideIcon, Snowflake, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslations } from "../translations.tsx";
import { cx } from "./cx.ts";

export type Tier = "hot" | "warm" | "cool";

const BADGE =
  "wt-badge inline-flex items-center gap-1 whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";
const TIERS: Record<Tier, [badge: string, icon: string, Icon: LucideIcon]> = {
  hot: ["bg-hot-soft text-hot-ink ring-hot-dot/25", "text-hot-dot", Flame],
  warm: ["bg-warm-soft text-warm-ink ring-warm-dot/30", "text-warm-dot", Sun],
  cool: ["bg-cool-soft text-cool-ink ring-cool-dot/25", "text-cool-dot", Snowflake],
};

/** A status badge's colour: neutral unless the status is good, needs care, or went wrong. */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";
const TONES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-ink-muted ring-line",
  accent: "bg-accent-soft text-accent-ink ring-accent/20",
  success: "bg-success-soft text-success-ink ring-success-ink/20",
  warning: "bg-warm-soft text-warm-ink ring-warm-dot/30",
  danger: "bg-danger-soft text-danger-ink ring-danger-line",
};

/** A lead's tier, in its word with its icon, or a status in the words a module gives (a role, say). */
export function Badge(props: { tier: Tier } | { children: ReactNode; tone?: BadgeTone }) {
  const t = useTranslations("ui.tier");
  if ("tier" in props) {
    const word = { hot: t("hot"), warm: t("warm"), cool: t("cool") }[props.tier];
    const [badge, icon, Icon] = TIERS[props.tier];
    return (
      <span className={cx(BADGE, badge)}>
        <Icon aria-hidden="true" strokeWidth={2.25} className={icon} />
        {word}
      </span>
    );
  }
  return <span className={cx(BADGE, TONES[props.tone ?? "neutral"])}>{props.children}</span>;
}

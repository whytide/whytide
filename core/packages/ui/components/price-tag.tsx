import { Coins } from "lucide-react";
import { useTranslations } from "../translations.tsx";

export type PriceTagProps = {
  /** Credits per unit, a decimal string as the prices route answers it ("0.25"); 0 is free. */
  credits: string;
  /** What one price is for, a word the module translated ("lookup"). */
  unit: string;
  /** A coming change, announced ahead: its credits per the same unit, and the instant it applies from. */
  next?: { credits: string; effectiveFrom: string | Date };
};

/**
 * What an action costs, shown before a person starts it: credits per unit, or free, and a coming
 * change with its date. The translator formats the numbers and the date, in the reader's locale.
 */
export function PriceTag({ credits, unit, next }: PriceTagProps) {
  const t = useTranslations("ui.price");
  const amount = Number(credits);
  return (
    <span className="wt-price-tag inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
      <span className="inline-flex h-6 items-center gap-1 rounded-md bg-muted px-2 font-medium text-ink ring-1 ring-line ring-inset tabular-nums">
        <Coins aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
        {amount === 0 ? t("free") : t("per_unit", { credits: amount, unit })}
      </span>
      {next ? (
        <span className="text-ink-muted tabular-nums">
          {t("next", { credits: Number(next.credits), unit, date: new Date(next.effectiveFrom) })}
        </span>
      ) : null}
    </span>
  );
}

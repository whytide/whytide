// A price on the campaign's page (README.md "Screens"; credits' README "Showing a price"): an entry of
// credits' price list, as the page read it, in the kit's PriceTag, its unit in campaigns' words, with
// a coming price and its date; a rise to another unit, which the tag cannot name, in the kit's own
// words beside it, as credits' costs page shows one.
import { PriceTag } from "@whytide/ui";
import { useTranslations } from "next-intl";

/** An entry of GET …/credits/prices, the fields the page shows. */
export type PriceEntry = {
  readonly credits: string;
  readonly unit: string;
  readonly next: {
    readonly credits: string;
    readonly unit: string;
    readonly effectiveFrom: string;
  } | null;
};

export function Price({ price: { credits, unit, next } }: { price: PriceEntry }) {
  const t = useTranslations("campaigns.price");
  const kit = useTranslations("ui.price");
  // The units campaigns' prices declare (prices.ts), each key written out; another, its code.
  const units: Readonly<Record<string, string>> = { send: t("send") };
  const word = (code: string) => (Object.hasOwn(units, code) ? (units[code] ?? code) : code);
  if (next === null || next.unit === unit) {
    return <PriceTag credits={credits} unit={word(unit)} next={next ?? undefined} />;
  }
  const date = new Date(next.effectiveFrom);
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <PriceTag credits={credits} unit={word(unit)} />
      <span className="text-xs text-ink-muted tabular-nums">
        {kit("next", { credits: Number(next.credits), unit: word(next.unit), date })}
      </span>
    </span>
  );
}

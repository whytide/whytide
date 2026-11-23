"use client";
// A research source's last plan on its card (README.md "Screen"; gamma-wr-041): the trade's words by
// language, in the member's language names, and the source types it looked in, by their labels, read
// from GET /sources/{id}/research-plan with its own loading and error states. It reads again when the
// source's run changes (a run opened or ended), so a plan written by the run shows when it ends.
import { Skeleton } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useLanguageName } from "./research-fields.tsx";
import { FORMAT } from "./when.tsx";

type Plan = {
  madeAt: string;
  words: { language: string; words: string[] }[];
  placeIds: string[];
};
type Props = { workspaceId: string; sourceId: string; refreshKey: string };

/** A fact of a card: its name over its value (as the card's other facts). */
const TERM = "text-xs font-medium text-ink-muted";

export function ResearchPlan({ workspaceId, sourceId, refreshKey }: Props) {
  const t = useTranslations("signals");
  const languageName = useLanguageName();
  const format = useFormatter();
  const [plan, setPlan] = useState<Plan | null | undefined>();
  const [failure, setFailure] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey is the reason to read again
  useEffect(() => {
    let current = true;
    setFailure(false);
    data(
      browserApi().GET("/v1/workspaces/{workspaceId}/signals/sources/{id}/research-plan", {
        params: { path: { workspaceId, id: sourceId } },
      }),
    )
      .then((read) => current && setPlan(read.plan))
      .catch((error: unknown) => {
        if (current) setFailure(!(error instanceof ApiError) || error.status !== 404);
      });
    return () => {
      current = false;
    };
  }, [workspaceId, sourceId, refreshKey]);

  /** A source type's label; its id when the build knows no such label. */
  const placeLabels: Record<string, string> = {
    association_members: t("places.association_members.label"),
    contracts_awarded: t("places.contracts_awarded.label"),
    customer_sites: t("places.customer_sites.label"),
    dealer_lists: t("places.dealer_lists.label"),
    distributor_lists: t("places.distributor_lists.label"),
    fair_exhibitors: t("places.fair_exhibitors.label"),
    public_tenders: t("places.public_tenders.label"),
    supplier_registries: t("places.supplier_registries.label"),
    web_search: t("places.web_search.label"),
  };
  const placeLabel = (id: string) => placeLabels[id] ?? id;

  if (failure) return <p className="text-ink-muted">{t("sources.plan_failed")}</p>;
  if (plan === undefined) return <Skeleton lines={2} />;
  if (plan === null) return <p className="text-ink-muted">{t("sources.plan_none")}</p>;
  return (
    <section aria-label={t("sources.plan_title")} className="grid gap-3">
      <h3 className="text-sm font-medium text-ink">
        {t.rich("sources.plan_made", {
          at: format.dateTime(new Date(plan.madeAt), FORMAT),
          time: (chunks) => <time dateTime={plan.madeAt}>{chunks}</time>,
        })}
      </h3>
      <dl className="grid gap-4 @md:grid-cols-2">
        {plan.placeIds.length === 0 ? null : (
          <div className="grid content-start gap-1 @md:col-span-2">
            <dt className={TERM}>{t("sources.plan_places")}</dt>
            <dd className="text-ink">{plan.placeIds.map(placeLabel).join(", ")}</dd>
          </div>
        )}
        {plan.words.map(({ language, words }) => (
          <div key={language} className="grid content-start gap-1 @md:col-span-2">
            <dt className={TERM}>
              {t("sources.plan_words", { language: languageName(language) })}
            </dt>
            <dd className="wrap-anywhere text-ink">{words.join(", ")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

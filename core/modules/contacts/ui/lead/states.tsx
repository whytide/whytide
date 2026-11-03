// The lead page's loading and not-found states (page.tsx), in the module's words: while the lead's
// snapshot and neighbours are read, the way back and the header of the lead already read, the wait
// announced, and cards that shimmer where the rest will come; and, for another workspace's person or
// one without a lead, a heading, why, and the way back to the list's view.
import { ButtonLink, EmptyState, PageHeader, Skeleton } from "@whytide/ui";
import { ArrowLeft } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import { LOADING_LINES } from "./constants.ts";
import { LeadHeader, LeadNav } from "./header.tsx";
import type { Lead } from "./page.tsx";

const CARD = "rounded-xl border border-line bg-surface p-5 shadow-xs";

/** `back`: the list's view, which the way back keeps. */
export function LeadLoading({ lead, name, back }: { lead: Lead; name: string; back: string }) {
  const t = useTranslations("contacts.lead");
  const [profile, why, side] = LOADING_LINES;
  return (
    <>
      <LeadNav back={back} />
      <LeadHeader lead={lead} name={name} />
      <p role="status" className="wt-loading-state mb-4 text-sm">
        <span className="wt-spinner" aria-hidden="true" />
        {t("loading")}
      </p>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid gap-6">
          <div className={CARD}>
            <Skeleton lines={profile} />
          </div>
          <div className={CARD}>
            <Skeleton lines={why} />
          </div>
        </div>
        <div className={CARD}>
          <Skeleton lines={side} />
        </div>
      </div>
    </>
  );
}

/** `query`: the list's view, `?status=…&sort=…`, that the way back keeps. */
export function LeadNotFound({ workspace, query }: { workspace: string; query: string }) {
  const t = useTranslations("contacts.lead");
  const errors = useTranslations("contacts.errors");
  return (
    <>
      <title>{t("not_found")}</title>
      <PageHeader title={t("not_found")} />
      <EmptyState
        message={errors("lead_not_found")}
        action={
          <div>
            <ButtonLink href={`/w/${workspace}/leads${query}`}>
              <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
              {t("back")}
            </ButtonLink>
          </div>
        }
      />
    </>
  );
}

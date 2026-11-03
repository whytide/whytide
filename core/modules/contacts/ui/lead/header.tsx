// The lead page's top (view.tsx, and states.tsx while the rest of the page loads): the way back to
// the list and to the neighbours; the header, the person's initial and name, their title at their
// company, then the tier, the status unless qualified, the fit with its bar, the location, and where
// the name came from, with the actions slot at the inline end. Shared: the server renders them in
// the loading state, the browser in the page.
import { Avatar, Badge, type BadgeTone, ButtonLink, Meter, PageHeader } from "@whytide/ui";
import { ArrowLeft, ChevronLeft, ChevronRight, MapPin } from "@whytide/ui/icons";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { Lead } from "./page.tsx";

type Status = Lead["qualificationStatus"];

/** Each status's colour as a badge: good, needs care, went wrong, or under way. */
const STATUS_TONE: Record<Status, BadgeTone> = {
  qualified: "success",
  needs_review: "warning",
  not_qualified: "neutral",
  hard_filtered: "neutral",
  ai_failed: "danger",
  pending: "accent",
};

/** A status in the list's words. */
export function useStatusText(): Record<Status, string> {
  const list = useTranslations("contacts.leads");
  return {
    qualified: list("status.qualified"),
    needs_review: list("status.needs_review"),
    not_qualified: list("status.not_qualified"),
    hard_filtered: list("status.hard_filtered"),
    ai_failed: list("status.ai_failed"),
    pending: list("status.pending"),
  };
}

/** A person's title at their company, or the one of the two they have; nothing without either. */
export function useRoleText() {
  const t = useTranslations("contacts.lead");
  return ({ title, companyName }: { title?: string | null; companyName?: string | null }) =>
    title && companyName
      ? t("role", { title, company: companyName })
      : title || companyName || undefined;
}

/** Where a field's value came from and when, small; nothing for a field without a value. */
export function useProvenance(person: Lead["person"]) {
  const t = useTranslations("contacts.lead");
  const format = useFormatter();
  return (field: string) => {
    const stamp = person.provenance[field];
    if (!stamp) return undefined;
    const at = format.dateTime(new Date(stamp.at), { dateStyle: "medium" });
    return (
      <small className="text-xs text-ink-subtle">
        {t("provenance", { source: stamp.source, at })}
      </small>
    );
  };
}

/** A status as a badge in its colour. */
export function StatusBadge({ status }: { status: Status }) {
  return <Badge tone={STATUS_TONE[status]}>{useStatusText()[status]}</Badge>;
}

export function LeadHeader(props: { lead: Lead; name: string; actions?: ReactNode }) {
  const { lead, name, actions } = props;
  const { person } = lead;
  const t = useTranslations("contacts.lead");
  const format = useFormatter();
  const from = useProvenance(person);
  const role = useRoleText()(person);
  const { locationText } = person;
  const named = from("firstName") ?? from("lastName");
  return (
    <PageHeader
      title={name}
      leading={<Avatar name={person.firstName || person.lastName || ""} size="lg" />}
      description={role}
      meta={
        <>
          {lead.tier && <Badge tier={lead.tier} />}
          {lead.qualificationStatus !== "qualified" && (
            <StatusBadge status={lead.qualificationStatus} />
          )}
          {lead.fitScore !== null && (
            <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
              {t("fit")}
              <span className="font-semibold text-ink tabular-nums">
                {format.number(lead.fitScore)}
              </span>
              <span className="w-16">
                <Meter value={lead.fitScore} />
              </span>
            </span>
          )}
          {locationText && (
            <span className="inline-flex items-center gap-1 text-xs text-ink-muted">
              <MapPin aria-hidden="true" className="size-3.5 shrink-0" />
              {locationText}
            </span>
          )}
          {named}
        </>
      }
      actions={actions}
    />
  );
}

/** The way back to the list's view, then to the previous and next lead in it, where there is one. */
export function LeadNav(props: { back: string; previous?: string | null; next?: string | null }) {
  const { back, previous, next } = props;
  const t = useTranslations("contacts.lead");
  return (
    <nav aria-label={t("navigation")} className="-mt-2 mb-5 flex min-h-8 items-center gap-2">
      <div className="-ms-2.5">
        <ButtonLink href={back} variant="ghost" size="sm">
          <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
          {t("back")}
        </ButtonLink>
      </div>
      <div className="ms-auto flex items-center gap-1.5">
        {previous && (
          <ButtonLink href={previous} rel="prev" size="sm">
            <ChevronLeft aria-hidden="true" className="rtl:-scale-x-100" />
            <span className="max-sm:sr-only">{t("previous")}</span>
          </ButtonLink>
        )}
        {next && (
          <ButtonLink href={next} rel="next" size="sm">
            <span className="max-sm:sr-only">{t("next")}</span>
            <ChevronRight aria-hidden="true" className="rtl:-scale-x-100" />
          </ButtonLink>
        )}
      </div>
    </nav>
  );
}

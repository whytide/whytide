// The lead page's top (view.tsx, and states.tsx while the rest of the page loads): the way back to
// the list and to the neighbours; the header, the person's initial and name, their title at their
// company, then, while the person may not be contacted, the never-contact badge with its reason,
// the tier, the status unless qualified, the outreach status (unless the never-contact badge says
// it), the fit with its bar, the location, and where the name came from, with the Never contact
// menu (the page's, not the loading state's) and the actions slot at the inline end. Shared: the
// server renders them in the loading state, the browser in the page.
import { Avatar, Badge, type BadgeTone, ButtonLink, Meter, PageHeader } from "@whytide/ui";
import { ArrowLeft, Ban, ChevronLeft, ChevronRight, MapPin } from "@whytide/ui/icons";
import { useFormatter, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { NeverContactMenu } from "../never-contact/block.tsx";
import type { Lead } from "./page.tsx";

type Status = Lead["qualificationStatus"];
type Reason = NonNullable<Lead["suppression"]>["reason"];
type Outreach = Lead["outreachStatus"];

/** Each status's colour as a badge: good, needs care, went wrong, or under way. */
const STATUS_TONE: Record<Status, BadgeTone> = {
  qualified: "success",
  needs_review: "warning",
  not_qualified: "neutral",
  hard_filtered: "neutral",
  ai_failed: "danger",
  pending: "accent",
};

/** Each outreach status's colour: waiting, approved or answered, under way, over, or blocked. */
const OUTREACH_TONE: Record<Outreach, BadgeTone> = {
  pending_review: "neutral",
  approved: "success",
  in_campaign: "accent",
  replied: "success",
  finished: "neutral",
  suppressed: "danger",
};

/** An outreach status in words, as the list's column, its filter and the header show it. */
export function useOutreachText(): Record<Outreach, string> {
  const t = useTranslations("contacts.outreach_status");
  return {
    pending_review: t("pending_review"),
    approved: t("approved"),
    in_campaign: t("in_campaign"),
    replied: t("replied"),
    finished: t("finished"),
    suppressed: t("suppressed"),
  };
}

/** An outreach status as a badge in its colour. */
export function OutreachBadge({ status }: { status: Outreach }) {
  return <Badge tone={OUTREACH_TONE[status]}>{useOutreachText()[status]}</Badge>;
}

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

/** Why the person may not be contacted: on the list, their company on it, or opted out. */
function SuppressionBadge({ reason }: { reason: Reason }) {
  const t = useTranslations("contacts.never_contact");
  return (
    <Badge tone="danger">
      <Ban aria-hidden="true" />
      {t("badge", { reason })}
    </Badge>
  );
}

/** `workspace`: the page's, for the Never contact menu, which the loading state leaves out. */
export function LeadHeader(props: {
  lead: Lead;
  name: string;
  actions?: ReactNode;
  workspace?: string;
}) {
  const { lead, name, actions, workspace } = props;
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
          {lead.suppression && <SuppressionBadge reason={lead.suppression.reason} />}
          {lead.tier && <Badge tier={lead.tier} />}
          {lead.qualificationStatus !== "qualified" && (
            <StatusBadge status={lead.qualificationStatus} />
          )}
          {/* Blocked says again what the never-contact badge says: one of the two. */}
          {!(lead.suppression && lead.outreachStatus === "suppressed") && (
            <OutreachBadge status={lead.outreachStatus} />
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
      actions={
        workspace === undefined ? (
          actions
        ) : (
          <>
            <NeverContactMenu
              workspace={workspace}
              personId={lead.personId}
              companyId={person.companyId}
            />
            {actions}
          </>
        )
      }
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

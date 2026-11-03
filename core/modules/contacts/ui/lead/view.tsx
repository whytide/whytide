// The lead page in the browser (page.tsx): the way back and to the neighbours; the header
// (header.tsx), with the Never contact menu (never-contact/block.tsx), Approve (approve.tsx) and the
// actions slot, and Approve's failure under it; a needs_review lead's unknown criteria; then two
// columns. The first: the person's business fields each with its source and time, and the LinkedIn
// link; the why; the snapshot, the model's summary under its label, the verdicts behind a disclosure
// and the disqualifiers; the evidence and draft slots. Beside it: the decision and its time (the
// snapshot's, else when the lead was decided) with the cost slot, then the review and outreach
// slots; in one column, on a phone, they come right after the why, so that the review is near.
// Codes that qualification stores (a why bullet, a criterion, a verdict, a disqualifier) are worded
// by its keys, read as data through useKeyText, as the lead list words a why bullet: a code without
// a key shows nothing, on both screens. A status and a confidence take the list's words. The
// LinkedIn link is the person's normalized profile URL, never another value. The slots hold the
// panels page.tsx rendered, each slot behind its own boundary (slot-boundary.tsx).
"use client";

import {
  Badge,
  type BadgeTone,
  Card,
  type Column,
  DataTable,
  Link,
  Meter,
  Toast,
  useKeyText,
} from "@whytide/ui";
import {
  Ban,
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleHelp,
  CircleX,
  ExternalLink,
  type LucideIcon,
  Sparkles,
  TriangleAlert,
} from "@whytide/ui/icons";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { normalizeLinkedinUrl } from "../../domain/linkedin-url.ts";
import { useToast } from "../never-contact/block.tsx";
import { ApproveButton, ApproveFailed, canApprove, useApprove } from "./approve.tsx";
import { LeadHeader, LeadNav, StatusBadge, useProvenance } from "./header.tsx";
import type { Lead, Neighbours, Snapshot } from "./page.tsx";
import { SlotBoundary } from "./slot-boundary.tsx";
import type { LeadSlot } from "./slots.ts";

type Props = {
  workspace: string;
  lead: Lead;
  /** The person's name, or the LinkedIn URL without one: page.tsx's, which titles the document. */
  name: string;
  snapshot: Snapshot | null;
  neighbours: Neighbours;
  /** The list's view, `?status=…&sort=…`, carried back to the list and to the neighbours. */
  query: string;
  slots: Partial<Record<LeadSlot, ReactNode>>;
  /** Whether the user has a connected LinkedIn account of their own, without which Approve waits. */
  hasSender: boolean;
};
type VerdictRow = Snapshot["verdicts"][number] & { id: string };
type Verdict = VerdictRow["verdict"];

/** Each verdict's colour and icon, beside its words. */
const VERDICT: Record<Verdict, [tone: BadgeTone, Icon: LucideIcon]> = {
  met: ["success", CircleCheck],
  partially_met: ["warning", CircleDot],
  not_met: ["danger", CircleX],
  unknown: ["neutral", CircleHelp],
};
const SECTION = "grid content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs";
const HEADING = "font-semibold text-ink";

export function LeadView(props: Props) {
  const { workspace, lead, name, snapshot, neighbours, query, slots, hasSender } = props;
  const t = useTranslations("contacts.lead");
  const list = useTranslations("contacts.leads");
  const format = useFormatter();
  const keyText = useKeyText();
  const from = useProvenance(lead.person);
  const { person } = lead;
  const date = (at: string) => format.dateTime(new Date(at), { dateStyle: "medium" });
  /** A slot's panels, each behind the slot's boundary; `className` lays them out. */
  const place = (slot: LeadSlot, className?: string) =>
    slots[slot] && (
      <div data-slot={slot} className={className}>
        <SlotBoundary>{slots[slot]}</SlotBoundary>
      </div>
    );
  const approveWords = useTranslations("contacts.approve");
  const [toast, setToast] = useToast();
  // Approve's answer stands for the lead read it answered; a new read (a block's router.refresh())
  // is a new object, whose status shows.
  const [approved, setApproved] = useState<{ of: Lead; to: Lead["outreachStatus"] }>();
  const outreach = approved?.of === lead ? approved.to : lead.outreachStatus;
  const approval = useApprove(workspace, (_, status, approvedName) => {
    setApproved({ of: lead, to: status });
    setToast(approveWords("done", { name: approvedName }));
  });
  const approve = canApprove(outreach) && (
    <ApproveButton
      workspace={workspace}
      status={outreach}
      hasSender={hasSender}
      busy={approval.busy !== undefined}
      onApprove={() => void approval.approve(lead.personId, name)}
    />
  );
  const actions = place("actions");
  const leads = `/w/${workspace}/leads`;
  const to = (personId: string) => `${leads}/${encodeURIComponent(personId)}${query}`;
  const confidenceText = {
    high: list("confidence.high"),
    medium: list("confidence.medium"),
    low: list("confidence.low"),
  };
  const fields = [
    { field: "headline", label: t("headline"), value: person.headline },
    { field: "title", label: t("job_title"), value: person.title },
    { field: "companyName", label: t("company"), value: person.companyName },
    { field: "locationText", label: t("location"), value: person.locationText },
  ];
  const status = lead.qualificationStatus;
  const fit = lead.fitScore;
  const decision = [
    { label: t("status"), value: <StatusBadge status={status} /> },
    {
      label: t("fit"),
      value: fit !== null && (
        <span className="flex items-center gap-2.5">
          {format.number(fit)}
          <span className="w-full max-w-24">
            <Meter value={fit} />
          </span>
        </span>
      ),
    },
    { label: t("tier"), value: lead.tier && <Badge tier={lead.tier} /> },
    { label: t("confidence"), value: lead.fitConfidence && confidenceText[lead.fitConfidence] },
    {
      label: t("icp_version"),
      value: lead.icpVersionScored === null ? null : format.number(lead.icpVersionScored),
    },
    // A lead without a snapshot was never scored (hard-filtered, failed): the time it was decided,
    // as the list's Qualified column shows it; a pending one has none.
    snapshot
      ? { label: t("scored_at"), value: date(snapshot.scoredAt) }
      : { label: t("decided_at"), value: status === "pending" ? null : date(lead.updatedAt) },
  ];
  /** The criteria the model could not judge, which make a lead needs_review, in their words. */
  const unknown =
    status === "needs_review"
      ? (snapshot?.verdicts ?? []).flatMap(({ criterion, verdict }) => {
          const words = verdict === "unknown" && keyText(`qualification.criterion.${criterion}`);
          return words ? [words] : [];
        })
      : [];
  const disqualifiers = (snapshot?.disqualifiers ?? []).flatMap((code) => {
    const words = keyText(`qualification.disqualifier.${code}`);
    return words === undefined
      ? []
      : [
          <li key={code} className="flex items-start gap-2">
            <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" />
            {words}
          </li>,
        ];
  });
  const why = lead.why.flatMap(({ key, params }, index) => {
    const words = keyText(key, params);
    return words === undefined
      ? []
      : [
          <li key={`${index}:${key}`} className="flex items-start gap-3">
            <span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" />
            {words}
          </li>,
        ];
  });
  const profile = normalizeLinkedinUrl(person.linkedinUrl);
  const columns: Column<VerdictRow>[] = [
    {
      id: "criterion",
      header: t("criterion"),
      cell: ({ criterion }) => (
        <span className="text-ink">{keyText(`qualification.criterion.${criterion}`)}</span>
      ),
    },
    {
      id: "verdict",
      header: t("verdict"),
      cell: ({ verdict }) => {
        const [tone, Icon] = VERDICT[verdict] ?? VERDICT.unknown;
        return (
          <Badge tone={tone}>
            <Icon aria-hidden="true" />
            {keyText(`qualification.verdict.${verdict}`)}
          </Badge>
        );
      },
    },
    {
      id: "evidence",
      header: t("evidence"),
      cell: ({ evidence }) => evidence && <q>{evidence}</q>,
    },
    {
      id: "weight",
      header: t("weight"),
      cell: ({ weight }) => (weight === null ? null : format.number(weight)),
    },
  ];

  return (
    <>
      <LeadNav
        back={`${leads}${query}`}
        previous={neighbours.previous && to(neighbours.previous)}
        next={neighbours.next && to(neighbours.next)}
      />
      <LeadHeader
        lead={{ ...lead, outreachStatus: outreach }}
        name={name}
        workspace={workspace}
        actions={
          (approve || actions) && (
            <>
              {approve}
              {actions}
            </>
          )
        }
      />
      {approval.failure && (
        <div className="mb-6">
          <ApproveFailed failure={approval.failure} />
        </div>
      )}
      <Toast message={toast} />
      {unknown.length > 0 && (
        <p className="mb-6 flex items-start gap-2.5 rounded-xl border border-warm-dot/30 bg-warm-soft px-4 py-3 text-warm-ink">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("unknown_criterion", {
            criteria: format.list(unknown, { type: "conjunction" }),
            count: unknown.length,
          })}
        </p>
      )}
      {/* Three parts in the order a phone shows them: the person and the why, the decision and the
          review, the details. From lg the second stands beside the other two, over both rows. */}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:grid-rows-[auto_1fr] xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid min-w-0 gap-6">
          <Card title={t("profile")}>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {fields.map(
                ({ field, label, value }) =>
                  value && (
                    <div
                      key={field}
                      className={`grid content-start gap-0.5 ${field === "headline" ? "sm:col-span-2" : ""}`}
                    >
                      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
                      <dd className="text-ink">{value}</dd>
                      <dd>{from(field)}</dd>
                    </div>
                  ),
              )}
            </dl>
            {profile && (
              <p className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t border-line pt-4">
                <Link href={profile} target="_blank" rel="noopener noreferrer">
                  {t("linkedin")}
                  <ExternalLink
                    aria-hidden="true"
                    className="ms-1 inline size-3.5 align-[-0.125em] rtl:-scale-x-100"
                  />
                </Link>
                {from("linkedinUrl")}
              </p>
            )}
          </Card>
          {why.length > 0 && (
            <Card title={t("why")}>
              <ul className="grid gap-2.5 text-ink">{why}</ul>
            </Card>
          )}
        </div>
        <div className="grid min-w-0 gap-6 lg:col-start-2 lg:row-span-2 lg:row-start-1">
          <Card title={t("qualification")}>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-4">
              {decision.map(
                ({ label, value }) =>
                  value && (
                    <div key={label} className="grid content-start gap-1">
                      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
                      <dd className="font-medium text-ink tabular-nums">{value}</dd>
                    </div>
                  ),
              )}
            </dl>
            {status === "hard_filtered" && (
              <p className="rounded-lg bg-muted px-3 py-2.5 text-ink-muted">{t("hard_filtered")}</p>
            )}
            {status === "ai_failed" && (
              <p className="rounded-lg bg-danger-soft px-3 py-2.5 text-danger-ink">
                {list("reason.ai_failed", {
                  reason: (lead.statusReason ?? "").replaceAll("-", "_"),
                })}
              </p>
            )}
            {place("cost", "border-t border-line pt-4")}
          </Card>
          {place("review", "grid gap-4")}
          {place("outreach", "grid gap-4")}
        </div>
        <div className="grid min-w-0 gap-6">
          {snapshot && (
            <div className={SECTION}>
              <section aria-labelledby="lead-summary" className="grid gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="lead-summary" className={HEADING}>
                    {t("summary")}
                  </h2>
                  <p className="shrink-0">
                    <Badge tone="accent">
                      <Sparkles aria-hidden="true" />
                      {t("summary_label")}
                    </Badge>
                  </p>
                </div>
                <p className="text-pretty leading-relaxed text-ink">{snapshot.summary}</p>
              </section>
              <details className="group border-t border-line pt-4">
                <summary className="-mx-1.5 flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-1.5 py-1 font-medium text-ink transition-colors hover:bg-hover [&::-webkit-details-marker]:hidden">
                  <ChevronDown
                    aria-hidden="true"
                    className="size-4 -rotate-90 text-ink-muted transition-transform group-open:rotate-0 rtl:rotate-90 rtl:group-open:rotate-0"
                  />
                  {t("verdicts")}
                </summary>
                <div className="mt-3">
                  <DataTable
                    caption={t("verdicts")}
                    columns={columns}
                    rows={snapshot.verdicts.map((verdict) => ({
                      ...verdict,
                      id: verdict.criterion,
                    }))}
                  />
                </div>
              </details>
              <section
                aria-labelledby="lead-disqualifiers"
                className="grid gap-2.5 border-t border-line pt-4"
              >
                <h2 id="lead-disqualifiers" className={HEADING}>
                  {t("disqualifiers")}
                </h2>
                {snapshot.disqualifiers.length === 0 ? (
                  <p className="flex items-center gap-2 text-ink-muted">
                    <CircleCheck aria-hidden="true" className="size-4 shrink-0 text-success-ink" />
                    {t("no_disqualifiers")}
                  </p>
                ) : (
                  <ul className="grid gap-2 text-ink">{disqualifiers}</ul>
                )}
              </section>
            </div>
          )}
          {place("evidence", "grid gap-4")}
          {place("draft", "grid gap-4")}
        </div>
      </div>
    </>
  );
}

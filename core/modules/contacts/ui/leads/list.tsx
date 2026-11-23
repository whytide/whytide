// The lead list in the browser (page.tsx): the filters by status, tier, review and outreach status,
// the sort by fit, newest or unreviewed first, the counts per status, and the table, paged by the
// api's cursor; each change reads GET …/contacts/leads again, the last one asked winning, and a
// filter or sort change writes itself into the address first, so that a reload and Back return to
// it (query.ts). While a filter change reads, the loading state stands in for the table; a sort or
// a page keeps it, busy, and the focus where it was. A failed read shows its code in words and a
// retry; an empty view says why: no lead yet, none in this view, or none left to review. A row's
// link opens the lead page with the view in its query. The Outreach column shows each lead's
// outreach status. The row menu, above the link, opens nothing: Approve (../lead/approve.tsx),
// and the one-click blocks of the person or their company (../never-contact/block.tsx); a toast
// says so, and the rows they change show their new status until the next read. Export downloads
// the CSV of the filters set (GET …/contacts/exports/leads.csv), its failure in words with a retry;
// a Member's 403 says that only an owner exports, with none (gamma-p6-010). Add lead, beside Export
// and in the empty state, opens the dialog that adds one lead by hand (add-lead.tsx), whose source
// the Source cell names Added manually (lead-manual-create).
// A view of one source (`?source=`, from a source's View leads) shows a chip above the table that
// names it, from the label of the listed leads' entry of that ref, or Added manually for a
// member's, with a Clear that drops it alone; it shows every status unless one is named, the status
// filter's All.
"use client";

import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Checkbox,
  type Column,
  DataTable,
  EmptyState,
  ErrorState,
  Menu,
  MenuItem,
  Meter,
  PageHeader,
  Select,
  Toast,
  useKeyText,
} from "@whytide/ui";
import {
  CircleCheck,
  Download,
  Ellipsis,
  FileUp,
  ListFilter,
  Radar,
  SignalHigh,
  SignalLow,
  SignalMedium,
  ThumbsDown,
  ThumbsUp,
  X,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { ApproveFailed, canApprove, useApprove } from "../lead/approve.tsx";
import { OutreachBadge, useOutreachText, useRoleText } from "../lead/header.tsx";
import { NeverContactItems, useToast } from "../never-contact/block.tsx";
import { useReasonText } from "../review-panel/reasons.ts";
import { AddLead } from "./add-lead.tsx";
import {
  filtersOf,
  OUTREACH,
  type Outreach,
  queryOf,
  SORTS,
  type Sort,
  STATUSES,
  type Status,
  TIERS,
  type Tier,
  type View,
  viewOf,
} from "./query.ts";
import { LeadsLoading } from "./skeleton.tsx";

export type { View } from "./query.ts";

/** How long the file's address lives: Firefox and Safari read it after the click (FileSaver.js). */
const KEEP_FILE_MS = 40_000;

/** Hands the file to the browser, under the name the api gives it. */
function save(file: Blob, response: Response) {
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = named?.[1] ?? "leads.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), KEEP_FILE_MS);
}

/** The column each sort is shown on; the sort select alone asks for unreviewed first. */
const COLUMN_OF: Record<Sort, string> = {
  fit: "fit",
  newest: "qualified_at",
  unreviewed_first: "review",
};
/** Each status's dot in the counts, its colour echoing the status. */
const DOT: Record<Status, string> = {
  qualified: "bg-success-ink",
  needs_review: "bg-warm-dot",
  not_qualified: "bg-line-strong",
  hard_filtered: "bg-line-strong",
  ai_failed: "bg-danger",
  pending: "bg-cool-dot",
};
const CONFIDENCE_ICON = { high: SignalHigh, medium: SignalMedium, low: SignalLow };
const sameFilters = (a: View, b: View) =>
  a.status === b.status &&
  a.tier === b.tier &&
  a.review === b.review &&
  a.outreach === b.outreach &&
  a.source === b.source;

const read = (workspaceId: string, view: View, limit: number) => {
  const { sort, cursors } = view;
  const status = view.status || undefined;
  const query = { status, sort, limit, ...filtersOf(view), cursor: cursors.at(-1) };
  const path = { workspaceId };
  return data(
    browserApi().GET("/v1/workspaces/{workspaceId}/contacts/leads", { params: { path, query } }),
  );
};
type LeadPage = Awaited<ReturnType<typeof read>>;
type Row = LeadPage["leads"][number] & { id: string };
type Source = Row["sources"][number];
type SourceKind = Source["kind"];
/** The most recent of the lead's sources, the later one of a tie; none for a lead without one. */
const latestOf = (sources: readonly Source[]) =>
  sources.reduce<Source | undefined>(
    (latest, entry) => (latest !== undefined && latest.at > entry.at ? latest : entry),
    undefined,
  );

type Props = {
  workspace: string;
  counts: Record<Status, number>;
  /** The first view, the URL's (qualified leads by fit unless it names another), and its first page. */
  start: View;
  first: LeadPage;
  limit: number;
};

export function LeadList({ workspace, counts, start, first, limit }: Props) {
  const t = useTranslations("contacts.leads");
  const decision = useTranslations("contacts.review");
  const never = useTranslations("contacts.never_contact");
  const [toast, setToast] = useToast();
  const format = useFormatter();
  const keyText = useKeyText();
  const reasonText = useReasonText();
  const roleText = useRoleText();
  const outreachText = useOutreachText();
  const outreachWords = useTranslations("contacts.outreach_status");
  const approveWords = useTranslations("contacts.approve");
  const search = useSearchParams();
  const [view, setView] = useState(start);
  const [shown, setShown] = useState({ view: start, page: first });
  const [failed, setFailed] = useState<string>();
  const [exporting, setExporting] = useState<{ failed?: string; busy?: boolean }>({});
  const asked = useRef(0);
  const wanted = useRef(start);
  const approval = useApprove(workspace, (personId, outreachStatus, approved) => {
    mark(outreachStatus, (row) => row.personId === personId);
    setToast(approveWords("done", { name: approved }));
  });

  /** The rows `which` picks show `outreachStatus`, as the api now has it, until the next read. */
  function mark(
    outreachStatus: Row["outreachStatus"],
    which: (row: LeadPage["leads"][number]) => boolean,
  ) {
    setShown(({ view: of, page }) => ({
      view: of,
      page: {
        ...page,
        leads: page.leads.map((row) => (which(row) ? { ...row, outreachStatus } : row)),
      },
    }));
  }

  function show(next: View) {
    wanted.current = next;
    setView(next);
    setFailed(undefined);
    const ask = ++asked.current;
    read(workspace, next, limit).then(
      (page) => {
        if (ask !== asked.current) return;
        setShown({ view: next, page });
        setFailed(undefined);
      },
      (error: unknown) => {
        if (ask === asked.current)
          setFailed(error instanceof ApiError ? error.code : "internal_error");
      },
    );
  }

  /** A filter or the sort: the view into the address, then its first page. */
  function choose(next: View) {
    window.history.pushState(null, "", `${window.location.pathname}${queryOf(next)}`);
    show(next);
  }

  // Back and Forward: the address names a view other than the one last asked for. Next.js's search
  // params say so, and the browser's event too: after a reload, Next.js can drop a quick second Back.
  const addressed = queryOf(viewOf(Object.fromEntries(search)));
  useEffect(() => {
    const follow = () => {
      const named = viewOf(Object.fromEntries(new URLSearchParams(window.location.search)));
      if (queryOf(named) !== queryOf(wanted.current)) show(named);
    };
    follow();
    window.addEventListener("popstate", follow);
    return () => window.removeEventListener("popstate", follow);
  }, [addressed]);

  /** The CSV of the filters set, through the api's client; a failure shows its code in words. */
  async function exportCsv() {
    setExporting({ busy: true });
    const path = { workspaceId: workspace };
    const query = { status: view.status || undefined, ...filtersOf(view) };
    try {
      const {
        data: file,
        error,
        response,
      } = await browserApi().GET("/v1/workspaces/{workspaceId}/contacts/exports/leads.csv", {
        params: { path, query },
        parseAs: "blob",
      });
      if (!response.ok || file === undefined) throw new ApiError(response.status, error);
      save(file, response);
      setExporting({});
    } catch (error) {
      setExporting({ failed: error instanceof ApiError ? error.code : "internal_error" });
    }
  }

  const statusText: Record<Status, string> = {
    qualified: t("status.qualified"),
    needs_review: t("status.needs_review"),
    not_qualified: t("status.not_qualified"),
    hard_filtered: t("status.hard_filtered"),
    ai_failed: t("status.ai_failed"),
    pending: t("status.pending"),
  };
  const tierText: Record<Tier, string> = {
    hot: t("tier.hot"),
    warm: t("tier.warm"),
    cool: t("tier.cool"),
  };
  const sourceText: Record<SourceKind, string> = {
    signal: t("source.signal"),
    imported: t("source.imported"),
    manual: t("source.manual"),
  };
  const reviewText = { good_lead: decision("good_lead"), not_a_fit: decision("not_a_fit") };
  const confidenceText = {
    high: t("confidence.high"),
    medium: t("confidence.medium"),
    low: t("confidence.low"),
  };
  /** The confidence in its word, after bars as many as it is high. */
  const confidence = ({ fitConfidence }: Row) => {
    if (!fitConfidence) return null;
    const Icon = CONFIDENCE_ICON[fitConfidence];
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
        {confidenceText[fitConfidence]}
      </span>
    );
  };
  /** The first why bullet, from its key; an ai_failed lead has none, and shows its reason instead. */
  const why = (lead: Row) => {
    const [bullet] = lead.why;
    if (bullet) return keyText(bullet.key, bullet.params);
    if (lead.qualificationStatus !== "ai_failed") return null;
    return t("reason.ai_failed", { reason: (lead.statusReason ?? "").replaceAll("-", "_") });
  };
  const name = ({ person }: Row) =>
    t("name", { first: person.firstName ?? "", last: person.lastName ?? "" }).trim() ||
    (person.linkedinUrl ?? t("unnamed"));
  /** The person, after the initial of their name (a URL's would mislead), their role under it. */
  const who = (lead: Row) => {
    const role = roleText(lead.person);
    return (
      <span className="flex min-w-52 items-center gap-3">
        <Avatar name={lead.person.firstName || lead.person.lastName || ""} />
        <span className="grid min-w-0">
          <span>{name(lead)}</span>{" "}
          {role && <span className="text-xs font-normal text-ink-muted">{role}</span>}
        </span>
      </span>
    );
  };
  /** The fit's number, then its bar. */
  const fit = ({ fitScore }: Row) =>
    fitScore !== null && (
      <span className="flex items-center gap-2.5">
        <span className="w-6 text-end font-medium text-ink">{fitScore}</span>
        <span className="w-12">
          <Meter value={fitScore} />
        </span>
      </span>
    );
  /** An import in words: Imported from its file when its entry names it, else Imported. */
  const importedText = (entry: Source) =>
    entry.label === undefined
      ? sourceText.imported
      : t("source.imported_from", { file: entry.label });
  /** A source in words: a signal's label, an import's file, Added manually, else its kind. */
  const sourceName = (entry: Source) => {
    if (entry.kind === "imported") return importedText(entry);
    if (entry.kind === "manual") return sourceText.manual;
    return entry.label !== undefined ? entry.label : sourceText[entry.kind];
  };
  /**
   * A source as the cell shows it: a signal source's label, linked to its post in a new tab, or a
   * signal without one linked to its source's runs, where the post is; Imported, from its file when
   * the entry names it; Added manually, a member's. Each link stands
   * above the row's own, which covers the row (the ui's DataTable), so that it takes the pointer.
   */
  const sourceLink = (entry: Source) => {
    if (entry.kind === "imported") return importedText(entry);
    if (entry.kind === "manual") return sourceText.manual;
    if (entry.label === undefined) {
      const runs = `/w/${workspace}/sources?runs=${encodeURIComponent(entry.ref)}`;
      return (
        <a className="wt-link relative z-10" href={runs}>
          {sourceText.signal}
        </a>
      );
    }
    if (entry.url === undefined) return entry.label;
    return (
      <a
        className="wt-link relative z-10"
        href={entry.url}
        target="_blank"
        rel="noreferrer"
        aria-label={t("source.post", { label: entry.label })}
      >
        {entry.label}
      </a>
    );
  };
  /** The most recent source, then +N, the others named on hover and for a screen reader. */
  const sourceCell = (lead: Row) => {
    const latest = latestOf(lead.sources);
    if (latest === undefined) return sourceText[lead.sourceLabel];
    const others = lead.sources.filter((entry) => entry !== latest).map(sourceName);
    if (others.length === 0) return sourceLink(latest);
    const also = t("source.others", { sources: format.list(others, { type: "unit" }) });
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
        {sourceLink(latest)}{" "}
        <span
          className="relative z-10 rounded-full bg-muted px-1.5 py-px text-2xs font-medium text-ink-muted ring-1 ring-line ring-inset"
          title={also}
        >
          <span aria-hidden="true">{t("source.more", { count: others.length })}</span>
          <span className="wt-visually-hidden">{also}</span>
        </span>
      </span>
    );
  };
  const columns: Column<Row>[] = [
    { id: "name", header: t("columns.name"), cell: who },
    { id: "tier", header: t("columns.tier"), cell: ({ tier }) => tier && <Badge tier={tier} /> },
    { id: "fit", header: t("columns.fit"), cell: fit, sortable: true },
    { id: "confidence", header: t("columns.confidence"), cell: confidence },
    { id: "source", header: t("columns.source"), cell: sourceCell },
    {
      id: "qualified_at",
      header: t("columns.qualified_at"),
      // The last decision's time: a pending lead has none.
      cell: (lead) =>
        lead.qualificationStatus === "pending" ? null : (
          <span className="whitespace-nowrap">
            {format.dateTime(new Date(lead.updatedAt), { dateStyle: "medium" })}
          </span>
        ),
      sortable: true,
    },
    {
      id: "why",
      header: t("columns.why"),
      // Two lines at most, the whole on hover: the column that gives way when the screen is narrow.
      cell: (lead) => {
        const words = why(lead);
        return (
          words && (
            <span className="line-clamp-2 min-w-40 max-w-72 text-pretty" title={words}>
              {words}
            </span>
          )
        );
      },
    },
    {
      id: "review",
      header: t("columns.review"),
      // A Not a fit's reason on hover, and for a screen reader in the cell's words.
      cell: ({ reviewStatus, reviewReasonCode }) => {
        if (reviewStatus === null) return null;
        const good = reviewStatus === "good_lead";
        const Thumb = good ? ThumbsUp : ThumbsDown;
        const badge = (
          <Badge tone={good ? "success" : "neutral"}>
            <Thumb aria-hidden="true" />
            {reviewText[reviewStatus]}
          </Badge>
        );
        if (reviewReasonCode === null) return badge;
        const because = decision("not_a_fit_because", { reason: reasonText[reviewReasonCode] });
        return (
          <span title={because}>
            <span aria-hidden="true">{badge}</span>
            <span className="wt-visually-hidden">{because}</span>
          </span>
        );
      },
    },
    {
      id: "outreach",
      header: t("columns.outreach"),
      cell: ({ outreachStatus }) => <OutreachBadge status={outreachStatus} />,
    },
    {
      id: "menu",
      header: t("columns.menu"),
      // The kit's Menu, standing above the row's link, which covers the row: a click on it, or on
      // one of its items, never opens the lead.
      cell: (lead) => (
        <div className="relative z-10 flex justify-end">
          <Menu
            trigger={
              <>
                <Ellipsis aria-hidden="true" className="size-4 shrink-0" />
                <span className="sr-only">{t("row_menu", { name: name(lead) })}</span>
              </>
            }
          >
            {canApprove(lead.outreachStatus) && (
              <MenuItem
                disabled={approval.busy === lead.personId}
                onClick={(event) => {
                  event.currentTarget.closest<HTMLElement>("[popover]")?.hidePopover();
                  void approval.approve(lead.personId, name(lead));
                }}
              >
                <CircleCheck aria-hidden="true" />
                {lead.outreachStatus === "approved"
                  ? approveWords("again")
                  : approveWords("action")}
              </MenuItem>
            )}
            <NeverContactItems
              workspace={workspace}
              personId={lead.personId}
              companyId={lead.person.companyId}
              labels={{ person: never("row.person"), company: never("row.company") }}
              onBlocked={(kind) => {
                setToast(kind === "person" ? never("toast.person") : never("toast.company"));
                const { personId, person } = lead;
                mark("suppressed", (row) =>
                  kind === "person"
                    ? row.personId === personId
                    : row.person.companyId === person.companyId,
                );
              }}
            />
          </Menu>
        </div>
      ),
    },
  ];
  const sortText: Record<Sort, string> = {
    fit: t("sort.fit"),
    newest: t("sort.newest"),
    unreviewed_first: t("sort.unreviewed_first"),
  };
  const { page } = shown;
  const cursors = shown.view.cursors;
  const next = page.nextCursor;
  const loading = view !== shown.view && failed === undefined;
  const leadsInAll = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const empty =
    leadsInAll === 0 && !view.source ? (
      <EmptyState
        message={t("empty.none")}
        action={
          <div>
            <ButtonLink href={`/w/${workspace}/sources`} variant="primary">
              <Radar aria-hidden="true" />
              {t("links.sources")}
            </ButtonLink>
            <ButtonLink href={`/w/${workspace}/import`}>
              <FileUp aria-hidden="true" />
              {t("links.import")}
            </ButtonLink>
            <AddLead workspace={workspace} />
          </div>
        }
      />
    ) : (
      <EmptyState
        message={shown.view.review === "unreviewed" ? t("empty.unreviewed") : t("empty.status")}
      />
    );

  /** The counts per status, the view's own current: quiet pills, read as a list, one row on a phone. */
  const pills = (
    <ul
      aria-label={t("counts_label")}
      className="flex gap-1.5 max-sm:-mx-4 max-sm:overflow-x-auto max-sm:px-4 max-sm:[scrollbar-width:none] sm:flex-wrap"
    >
      {STATUSES.map((status) => (
        <li
          key={status}
          aria-current={status === view.status || undefined}
          className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ${
            status === view.status
              ? "bg-accent-soft text-accent-ink ring-accent/30"
              : "bg-surface text-ink-muted ring-line"
          }`}
        >
          <span aria-hidden="true" className={`size-1.5 rounded-full ${DOT[status]}`} />
          {statusText[status]}{" "}
          <span className="font-semibold text-ink tabular-nums">
            {format.number(counts[status])}
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        meta={pills}
        actions={
          <>
            <Button onClick={exportCsv} loading={exporting.busy}>
              <Download aria-hidden="true" />
              {t("export")}
            </Button>
            <AddLead workspace={workspace} />
          </>
        }
      />
      <div className="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs sm:flex sm:flex-wrap [&_.wt-field]:min-w-0">
        <div className="sm:w-44">
          <Select
            label={t("filter.status")}
            value={view.status}
            options={[
              // Every status: a source's view only, its first view.
              ...(view.source ? [{ value: "", label: t("status.all") }] : []),
              ...STATUSES.map((status) => ({ value: status, label: statusText[status] })),
            ]}
            onChange={(event) =>
              choose({ ...view, status: event.target.value as View["status"], cursors: [] })
            }
          />
        </div>
        <div className="sm:w-36">
          <Select
            label={t("filter.tier")}
            value={view.tier}
            options={[
              { value: "", label: t("tier.all") },
              ...TIERS.map((tier) => ({ value: tier, label: tierText[tier] })),
            ]}
            onChange={(event) =>
              choose({ ...view, tier: event.target.value as View["tier"], cursors: [] })
            }
          />
        </div>
        <div className="sm:w-44">
          <Select
            label={t("filter.outreach")}
            value={view.outreach}
            options={[
              { value: "", label: outreachWords("all") },
              ...OUTREACH.map((outreach) => ({ value: outreach, label: outreachText[outreach] })),
            ]}
            onChange={(event) =>
              choose({ ...view, outreach: event.target.value as Outreach | "", cursors: [] })
            }
          />
        </div>
        <div className="flex h-9 items-center sm:px-1">
          <Checkbox
            label={t("filter.review")}
            checked={view.review === "unreviewed"}
            onChange={(event) =>
              choose({ ...view, review: event.target.checked ? "unreviewed" : "", cursors: [] })
            }
          />
        </div>
        <div className="sm:ms-auto sm:w-48">
          <Select
            label={t("sort.label")}
            value={view.sort}
            options={SORTS.map((sort) => ({ value: sort, label: sortText[sort] }))}
            onChange={(event) => choose({ ...view, sort: event.target.value as Sort, cursors: [] })}
          />
        </div>
      </div>
      {view.source ? (
        <SourceChip
          entry={entryOf(view.source, view.source === shown.view.source ? page.leads : [])}
          clear={`/w/${workspace}/leads${queryOf({ ...view, status: view.status || "qualified", source: "", cursors: [] })}`}
        />
      ) : null}
      {exporting.failed === "forbidden" ? (
        <p role="status" className="mb-4 text-sm text-ink-muted">
          {t("export_owner_only")}
        </p>
      ) : exporting.failed ? (
        <div className="mb-4">
          <ErrorState module="contacts" code={exporting.failed} onRetry={exportCsv} />
        </div>
      ) : null}
      {approval.failure ? (
        <div className="mb-4">
          <ApproveFailed failure={approval.failure} />
        </div>
      ) : null}
      {failed ? (
        <div className="grid gap-3">
          <p className="font-medium text-ink">{t("error")}</p>
          <ErrorState module="contacts" code={failed} onRetry={() => show(view)} />
        </div>
      ) : loading && !sameFilters(view, shown.view) ? (
        <LeadsLoading />
      ) : (
        <div
          aria-busy={loading || undefined}
          className="transition-opacity duration-150 aria-busy:opacity-60"
        >
          <DataTable
            caption={t("title")}
            columns={columns}
            rows={page.leads.map((lead) => ({ ...lead, id: lead.personId }))}
            rowHref={({ personId }) =>
              `/w/${workspace}/leads/${encodeURIComponent(personId)}${queryOf(shown.view)}`
            }
            sort={{
              column: COLUMN_OF[view.sort],
              direction: view.sort === "unreviewed_first" ? "ascending" : "descending",
            }}
            onSortChange={({ column }) => {
              // The api sorts each one way: a second press keeps it.
              const sort = column === "fit" ? "fit" : "newest";
              if (sort !== view.sort) choose({ ...view, sort, cursors: [] });
            }}
            pager={{
              onPrevious:
                cursors.length > 0
                  ? () => show({ ...shown.view, cursors: cursors.slice(0, -1) })
                  : undefined,
              onNext: next ? () => show({ ...shown.view, cursors: [...cursors, next] }) : undefined,
            }}
            empty={empty}
          />
        </div>
      )}
      <Toast message={toast} />
    </>
  );
}

/** This ref's entry among the listed leads' sources: the first with a label, else the first. */
function entryOf(ref: string, leads: readonly { sources: readonly Source[] }[]) {
  const entries = leads.flatMap((lead) => lead.sources.filter((entry) => entry.ref === ref));
  return entries.find((entry) => entry.label !== undefined) ?? entries[0];
}

/**
 * The view's source, named by its label, Added manually for a member's, else "One source"; Clear, a
 * link to the same view without it, which reads the counts of every lead again.
 */
function SourceChip({ entry, clear }: { entry: Source | undefined; clear: string }) {
  const t = useTranslations("contacts.leads.source_filter");
  const label = entry?.label;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-accent-soft px-3 py-1 text-sm text-accent-ink ring-1 ring-accent/30 ring-inset">
        <ListFilter aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 wrap-break-word">
          {entry?.kind === "manual"
            ? t("manual")
            : label === undefined
              ? t("one")
              : t("named", { source: label })}
        </span>
      </span>
      <ButtonLink href={clear} variant="ghost" size="sm">
        <X aria-hidden="true" />
        {t("clear")}
      </ButtonLink>
    </div>
  );
}

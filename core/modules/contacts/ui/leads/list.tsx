// The lead list in the browser (page.tsx): the filters by status, tier and review, the sort by fit,
// newest or unreviewed first, the counts per status, and the table, paged by the api's cursor; each
// change reads GET …/contacts/leads again, the last one asked winning, and a filter or sort change
// writes itself into the address first, so that a reload and Back return to it (query.ts). While a
// filter change reads, the loading state stands in for the table; a sort or a page keeps it, busy,
// and the focus where it was. A failed read shows its code in words and a retry; an empty view says
// why: no lead yet, none in this view, or none left to review. A row's link opens the lead page
// with the view in its query. Export downloads the CSV of the filters set (GET
// …/contacts/exports/leads.csv), its failure in words with a retry.
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
  Meter,
  PageHeader,
  Select,
  useKeyText,
} from "@whytide/ui";
import {
  Download,
  FileUp,
  Radar,
  SignalHigh,
  SignalLow,
  SignalMedium,
  ThumbsDown,
  ThumbsUp,
} from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useSearchParams } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { useRoleText } from "../lead/header.tsx";
import { useReasonText } from "../review-panel/reasons.ts";
import {
  filtersOf,
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
  a.status === b.status && a.tier === b.tier && a.review === b.review;

const read = (workspaceId: string, view: View, limit: number) => {
  const { status, sort, cursors } = view;
  const query = { status, sort, limit, ...filtersOf(view), cursor: cursors.at(-1) };
  const path = { workspaceId };
  return data(
    browserApi().GET("/v1/workspaces/{workspaceId}/contacts/leads", { params: { path, query } }),
  );
};
type LeadPage = Awaited<ReturnType<typeof read>>;
type Row = LeadPage["leads"][number] & { id: string };
type Source = Row["sources"][number];
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
  const format = useFormatter();
  const keyText = useKeyText();
  const reasonText = useReasonText();
  const roleText = useRoleText();
  const search = useSearchParams();
  const [view, setView] = useState(start);
  const [shown, setShown] = useState({ view: start, page: first });
  const [failed, setFailed] = useState<string>();
  const [exporting, setExporting] = useState<{ failed?: string; busy?: boolean }>({});
  const asked = useRef(0);
  const wanted = useRef(start);

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
    const query = { status: view.status, ...filtersOf(view) };
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
  const sourceText = { signal: t("source.signal"), imported: t("source.imported") };
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
    person.linkedinUrl;
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
  /** A source in words: a signal source's label, else its kind's word. */
  const sourceName = (entry: Source) =>
    entry.kind === "signal" && entry.label !== undefined ? entry.label : sourceText[entry.kind];
  /**
   * A source as the cell shows it: a signal source's label, linked to its post in a new tab, or a
   * signal without one linked to its source's runs, where the post is; Imported. Each link stands
   * above the row's own, which covers the row (the ui's DataTable), so that it takes the pointer.
   */
  const sourceLink = (entry: Source) => {
    if (entry.kind === "imported") return sourceText.imported;
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
    leadsInAll === 0 ? (
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
          <Button onClick={exportCsv} loading={exporting.busy}>
            <Download aria-hidden="true" />
            {t("export")}
          </Button>
        }
      />
      <div className="mb-4 grid grid-cols-2 items-end gap-3 rounded-xl border border-line bg-surface p-3 shadow-xs sm:flex sm:flex-wrap [&_.wt-field]:min-w-0">
        <div className="sm:w-44">
          <Select
            label={t("filter.status")}
            value={view.status}
            options={STATUSES.map((status) => ({ value: status, label: statusText[status] }))}
            onChange={(event) =>
              choose({ ...view, status: event.target.value as Status, cursors: [] })
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
      {exporting.failed ? (
        <div className="mb-4">
          <ErrorState module="contacts" code={exporting.failed} onRetry={exportCsv} />
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
    </>
  );
}

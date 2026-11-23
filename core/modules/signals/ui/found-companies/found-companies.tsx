"use client";
// The Companies found screen in the browser (README.md "Screen"; gamma-wr-111): the workspace's found
// companies as part 1's route answers them (gamma-wr-110), read through the web's API client with the
// member's session. The filters are a source, an agent and a verdict, the first two from the workspace's
// sources (an agent is one a source belongs to); the verdict opens on fit and unsure, the route's
// default. A page of 25 comes first and Show more reads the next by the cursor. The loading state shows
// the cards as skeletons, a failed read the error state with a retry, and no company the empty state.
// Who is signed in (GET /v1/me) says what is offered: Not a fit to a member who may write the
// company's source (its creator, or a holder of signals.manage; a company whose source is gone, the
// latter alone), which asks first and moves the card away unless the verdict shown is Not a fit; and
// Download CSV, the filters' view as a file, to a holder of exports.read (an Owner or an Admin). The
// address follows the filters (`?source=`, `?agent=`, `?verdict=`), so that a card, a panel or a
// member can link to a view.
import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  Skeleton,
} from "@whytide/ui";
import { Download } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useState } from "react";
import { SIGNALS_MANAGE_ROLES } from "../../domain/constants.ts";
import { type Company, CompanyCard } from "./company-card.tsx";
import {
  ANY,
  FOUND_EXPORT_PATH,
  FOUND_EXPORT_ROLES,
  FOUND_PAGE_SIZE,
  FOUND_PATH,
  foundScreen,
  NOT_FIT_PATH,
  SKELETON,
  VERDICT_FILTERS,
  type VerdictFilter,
} from "./constants.ts";

/** What the filters need of a source, and who may write it. */
type SourceRow = {
  id: string;
  label: string;
  createdBy: string;
  playbook: { id: string; name: string } | null;
};
type Viewer = { userId: string; manages: boolean; exports: boolean };
type Meta = { viewer: Viewer; sources: SourceRow[] };
type Filters = { source: string; agent: string; verdict: VerdictFilter };
type List = { companies: Company[]; nextCursor: string | null };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

/** How long the file's address lives: Firefox and Safari read it after the click (FileSaver.js). */
const KEEP_FILE_MS = 40_000;

/** Hands the file to the browser, under the name the api gives it. */
function save(file: Blob, response: Response) {
  const named = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "");
  const href = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = href;
  link.download = named?.[1] ?? "companies-found.csv";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(href), KEEP_FILE_MS);
}

/** The filters as the route's query: a choice left at Any is not sent. */
const queryOf = ({ source, agent, verdict }: Filters) => ({
  sourceId: source || undefined,
  playbookId: agent || undefined,
  verdict: verdict || undefined,
});

export function FoundCompanies(props: { workspaceId: string; initial: Partial<Filters> }) {
  const { workspaceId } = props;
  const t = useTranslations("signals.found");
  const [filters, setFilters] = useState<Filters>({
    source: props.initial.source ?? ANY,
    agent: props.initial.agent ?? ANY,
    verdict: props.initial.verdict ?? ANY,
  });
  const [meta, setMeta] = useState<Meta>();
  const [list, setList] = useState<List>();
  const [failure, setFailure] = useState<string>();
  /** Raised by Try again, which reads once more. */
  const [attempt, setAttempt] = useState(0);
  const [more, setMore] = useState<{ busy: boolean; failed?: string }>({ busy: false });
  /** The company Not a fit asks about, the refusal of the last mark, and the name just marked. */
  const [asking, setAsking] = useState<Company>();
  const [marking, setMarking] = useState<{ busy: boolean; failed?: string }>({ busy: false });
  const [marked, setMarked] = useState<string>();
  const [exporting, setExporting] = useState<{ busy: boolean; failed?: string }>({ busy: false });

  // One read of the member and the sources per attempt: they say who may write what, and fill the
  // filters.
  useEffect(() => {
    let live = true;
    const path = { workspaceId };
    void attempt;
    Promise.all([
      data(browserApi().GET("/v1/workspaces/{workspaceId}/signals/sources", { params: { path } })),
      data(browserApi().GET("/v1/me")),
    ]).then(
      ([{ sources }, me]) => {
        if (!live) return;
        const role = me.memberships.find(
          (membership) => membership.workspaceId === workspaceId || membership.slug === workspaceId,
        )?.role;
        const viewer = {
          userId: me.user.id,
          manages: SIGNALS_MANAGE_ROLES.some((manager) => manager === role),
          exports: FOUND_EXPORT_ROLES.some((exporter) => exporter === role),
        };
        setMeta({ viewer, sources });
      },
      (error: unknown) => live && setFailure(codeOf(error)),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, attempt]);

  // The first page of the view the filters name; a read that answers late is dropped.
  useEffect(() => {
    let live = true;
    setList(undefined);
    setMore({ busy: false });
    void attempt;
    const path = { workspaceId };
    const query = { ...queryOf(filters), limit: FOUND_PAGE_SIZE };
    data(browserApi().GET(FOUND_PATH, { params: { path, query } })).then(
      (page) => {
        if (!live) return;
        setFailure(undefined);
        setList(page);
      },
      (error: unknown) => live && setFailure(codeOf(error)),
    );
    return () => {
      live = false;
    };
  }, [workspaceId, filters, attempt]);

  /** A filter changed: the view, and the address with it, which the page keeps in its history. */
  function choose(change: Partial<Filters>) {
    const next = { ...filters, ...change };
    setFilters(next);
    setMarked(undefined);
    setFailure(undefined);
    window.history.replaceState(null, "", foundScreen(workspaceId, next));
  }

  function retry() {
    setFailure(undefined);
    setAttempt((count) => count + 1);
  }

  async function showMore() {
    if (list?.nextCursor == null) return;
    setMore({ busy: true });
    try {
      const path = { workspaceId };
      const query = { ...queryOf(filters), limit: FOUND_PAGE_SIZE, cursor: list.nextCursor };
      const page = await data(browserApi().GET(FOUND_PATH, { params: { path, query } }));
      setList({ companies: [...list.companies, ...page.companies], nextCursor: page.nextCursor });
      setMore({ busy: false });
    } catch (error) {
      setMore({ busy: false, failed: codeOf(error) });
    }
  }

  /** Not a fit, once the member confirmed: the company moves, and leaves a view that excludes it. */
  async function markNotFit(company: Company) {
    setMarking({ busy: true });
    try {
      const params = { path: { workspaceId, id: company.id } };
      const answer = await data(browserApi().POST(NOT_FIT_PATH, { params }));
      setList((shown) => {
        if (shown === undefined) return shown;
        const keep = filters.verdict === "not_fit";
        const companies = shown.companies.flatMap((row) =>
          row.id !== company.id ? [row] : keep ? [answer] : [],
        );
        return { ...shown, companies };
      });
      setMarked(company.name);
      setAsking(undefined);
      setMarking({ busy: false });
    } catch (error) {
      setAsking(undefined);
      setMarking({ busy: false, failed: codeOf(error) });
    }
  }

  async function exportCsv() {
    setExporting({ busy: true });
    try {
      const params = { path: { workspaceId }, query: queryOf(filters) };
      const {
        data: file,
        error,
        response,
      } = await browserApi().GET(FOUND_EXPORT_PATH, { params, parseAs: "blob" });
      if (!response.ok || file === undefined) throw new ApiError(response.status, error);
      save(file, response);
      setExporting({ busy: false });
    } catch (error) {
      setExporting({ busy: false, failed: codeOf(error) });
    }
  }

  const sources = meta?.sources ?? [];
  const agents = useMemo(() => {
    const byId = new Map<string, string>();
    for (const { playbook } of sources) if (playbook) byId.set(playbook.id, playbook.name);
    return [...byId].map(([value, label]) => ({ value, label }));
  }, [sources]);
  const writableBy = useCallback(
    (company: Company): boolean => {
      if (meta === undefined) return false;
      if (meta.viewer.manages) return true;
      const source = sources.find(({ id }) => id === company.sourceId);
      return source !== undefined && source.createdBy === meta.viewer.userId;
    },
    [meta, sources],
  );

  const verdictText: Record<VerdictFilter, string> = {
    "": t("filter.verdict_default"),
    fit: t("filter.verdict_fit"),
    unsure: t("filter.verdict_unsure"),
    not_fit: t("filter.verdict_not_fit"),
  };

  const filtersBar = (
    <div className="grid gap-4 sm:grid-cols-3">
      <Select
        label={t("filter.source")}
        value={filters.source}
        onChange={(event) => choose({ source: event.target.value })}
        options={[
          { value: ANY, label: t("filter.any_source") },
          ...sources.map(({ id, label }) => ({ value: id, label })),
        ]}
      />
      <Select
        label={t("filter.agent")}
        value={filters.agent}
        onChange={(event) => choose({ agent: event.target.value })}
        options={[{ value: ANY, label: t("filter.any_agent") }, ...agents]}
      />
      <Select
        label={t("filter.verdict")}
        value={filters.verdict}
        onChange={(event) => choose({ verdict: event.target.value as VerdictFilter })}
        options={VERDICT_FILTERS.map((value) => ({ value, label: verdictText[value] }))}
      />
    </div>
  );

  return (
    <div className="grid gap-6">
      {filtersBar}
      {meta?.viewer.exports ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={exportCsv} loading={exporting.busy}>
            <Download aria-hidden="true" />
            {t("download")}
          </Button>
          {exporting.failed === "forbidden" ? (
            <p role="status" className="text-sm text-ink-muted">
              {t("download_owner_only")}
            </p>
          ) : null}
        </div>
      ) : null}
      {exporting.failed && exporting.failed !== "forbidden" ? (
        <ErrorState module="signals" code={exporting.failed} onRetry={exportCsv} />
      ) : null}
      {marked !== undefined ? (
        <p role="status" className="text-ink-muted">
          {t("marked", { name: marked })}
        </p>
      ) : null}
      {marking.failed ? <ErrorState module="signals" code={marking.failed} /> : null}
      {failure ? (
        <ErrorState module="signals" code={failure} onRetry={retry} />
      ) : list === undefined || meta === undefined ? (
        <div className="grid gap-4">
          <LoadingState />
          {Array.from({ length: SKELETON.cards }, (_, card) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed count of identical placeholders
            <Skeleton key={card} lines={SKELETON.lines} />
          ))}
        </div>
      ) : list.companies.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <>
          <ul className="grid gap-4">
            {list.companies.map((company) => (
              <CompanyCard
                key={company.id}
                company={company}
                writable={writableBy(company)}
                onNotFit={(row) => {
                  setMarking({ busy: false });
                  setAsking(row);
                }}
              />
            ))}
          </ul>
          {list.nextCursor !== null ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={showMore} loading={more.busy}>
                {t("show_more")}
              </Button>
              {more.failed ? (
                <ErrorState module="signals" code={more.failed} onRetry={showMore} />
              ) : null}
            </div>
          ) : null}
        </>
      )}
      <Dialog
        open={asking !== undefined}
        onClose={() => setAsking(undefined)}
        title={t("not_fit_title", { name: asking?.name ?? "" })}
        actions={
          <Button
            variant="danger"
            loading={marking.busy}
            onClick={() => asking && void markNotFit(asking)}
          >
            {t("not_fit_confirm")}
          </Button>
        }
      >
        <p className="my-3">{t("not_fit_body")}</p>
      </Dialog>
    </div>
  );
}

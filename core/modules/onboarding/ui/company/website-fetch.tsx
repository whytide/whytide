// The Draft from website (README "The screen"), a client component of the Company Knowledge form:
// the website's field, then the Draft button, which asks first when a draft waits for review; the
// progress while the worker reads the site, then while the drafter reads the pages, a bar for each
// step, the record asked for again every two seconds until the run ends, a failed read shown with a
// retry, or a run that looks stuck, when the asking stops; then the pages read, each linked, or the
// failure in words. A blocked address and a name that does not resolve read the same, so that nobody
// learns from the screen which names resolve to private addresses. The Draft's start is
// draft-start.tsx, which the documents' card starts its Draft with too.
"use client";

import { Badge, Button, ErrorState, Link } from "@whytide/ui";
import { CircleAlert, FileText, Sparkles, TriangleAlert } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import type { CompanyKnowledgeResponse } from "../../schemas/company-knowledge.ts";
import { DRAFTER_CODES, POLL_MS, STUCK_MS } from "./constants.ts";
import { type DraftStartProps, useDraftStart } from "./draft-start.tsx";
import { codeOf } from "./problem.ts";

type Knowledge = CompanyKnowledgeResponse;
type Props = DraftStartProps & {
  /** Whether the form holds a website. */
  website: boolean;
  /** The website's field, which the form holds. */
  field: ReactNode;
};

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";
/** A step's bar while the run is on it, and once it is done. */
const STEP = "h-1 rounded-full bg-accent";
const STEP_ON = `${STEP} animate-pulse`;
const STEP_NEXT = "h-1 rounded-full bg-accent/20";

/** Fetching or drafting, and the record unchanged for more than twenty minutes, by its `updatedAt`. */
export function isStuck(record: Knowledge, now = Date.now()): boolean {
  const running = record.fetchStatus === "fetching" || record.fetchStatus === "fetched";
  return running && now - Date.parse(record.updatedAt) > STUCK_MS;
}

export function WebsiteFetch(props: Props) {
  const { workspace, record, website, onRecord, field } = props;
  const t = useTranslations("onboarding");
  const id = useId();
  const [readFailure, setReadFailure] = useState<string>();
  const { press, starting, confirm, problem } = useDraftStart(props, t("company.draft"), () =>
    setReadFailure(undefined),
  );
  const fetching = record.fetchStatus === "fetching";
  const drafting = record.fetchStatus === "fetched";
  const stuck = isStuck(record);
  const polling = (fetching || drafting) && !stuck && readFailure === undefined;

  useEffect(() => {
    if (!polling) return;
    const params = { path: { workspaceId: workspace } };
    const timer = setInterval(async () => {
      try {
        onRecord(await data(browserApi().GET(PATH, { params })));
      } catch (error) {
        setReadFailure(codeOf(error));
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, workspace, onRecord]);

  /** Failed with a drafter's code: the pages were read, the draft failed. */
  const drafterFailed =
    record.fetchStatus === "failed" && DRAFTER_CODES.some((code) => code === record.fetchError);

  return (
    <div data-part="website-fetch" className="grid gap-4">
      {field}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button onClick={() => press()} loading={starting} disabled={!website}>
          <Sparkles aria-hidden="true" className="text-accent-ink" />
          {t("company.draft")}
        </Button>
        <p className="min-w-0 flex-1 basis-64 text-xs text-ink-muted">{t("company.draft_hint")}</p>
      </div>
      {confirm}
      {problem}
      {readFailure !== undefined ? (
        <div className="grid gap-2">
          <p className="font-medium text-ink">{t("company.error")}</p>
          <ErrorState
            module="onboarding"
            code={readFailure}
            onRetry={() => setReadFailure(undefined)}
          />
        </div>
      ) : stuck ? (
        <p
          role="status"
          className="flex items-start gap-2.5 rounded-lg bg-warm-soft px-3.5 py-3 text-warm-ink"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("company.stuck")}
        </p>
      ) : polling ? (
        <div className="grid gap-3 rounded-lg bg-accent-soft px-3.5 py-3">
          <p role="status" className="flex items-center gap-2.5 font-medium text-accent-ink">
            <span className="wt-spinner" aria-hidden="true" />
            {fetching ? t("company.fetching") : t("company.drafting")}
          </p>
          <span aria-hidden="true" className="grid grid-cols-2 gap-1.5">
            <span className={fetching ? STEP_ON : STEP} />
            <span className={fetching ? STEP_NEXT : STEP_ON} />
          </span>
        </div>
      ) : null}
      {record.fetchStatus === "failed" ? (
        <div role="alert" className="wt-error-state">
          <p className="flex items-center gap-2 font-medium text-danger-ink">
            <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
            {drafterFailed ? t("company.draft_failed") : t("company.fetch_failed")}
          </p>
          <p className="text-ink">
            <RunFailure code={record.fetchError} />
          </p>
        </div>
      ) : null}
      {drafting || record.fetchStatus === "drafted" || drafterFailed ? (
        <section aria-labelledby={`${id}-pages`} className="grid gap-2.5">
          <h2 id={`${id}-pages`} className="text-sm font-semibold text-ink">
            {t("company.pages_read", { count: record.pages.length })}
          </h2>
          {record.pages.length === 0 ? (
            <p className="text-ink-muted">{t("company.pages_empty")}</p>
          ) : (
            // Contained inline: a long title shortens in its chip, never widens the form on a phone.
            <ul className="flex flex-wrap gap-2 contain-inline-size">
              {record.pages.map((page) => (
                <li
                  key={page.url}
                  className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-line bg-muted px-2.5 py-1.5"
                >
                  <FileText aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
                  <span className="min-w-0 truncate">
                    {/^https?:\/\//i.test(page.url) ? (
                      <Link href={page.url} target="_blank" rel="noopener noreferrer">
                        {page.title || page.url}
                      </Link>
                    ) : (
                      page.title || page.url
                    )}
                  </span>
                  {page.status === "truncated" ? (
                    <Badge tone="warning">{t("company.page_truncated")}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}

/**
 * A failed run's code in words, the Company screen's and the prompt's (README "The screen"): the
 * fetch's, a blocked address and an unresolved name alike, so that nobody learns from the screen
 * which names resolve to private addresses; the drafter's; else the fetch's own failure.
 */
export function RunFailure({ code }: { code: string | null }) {
  const t = useTranslations("onboarding");
  return code === "egress_blocked_address" || code === "egress_dns_failed"
    ? t("errors.egress_blocked_address")
    : code === "egress_timeout"
      ? t("errors.egress_timeout")
      : code === "egress_too_large"
        ? t("errors.egress_too_large")
        : code === "ai_failed"
          ? t("errors.ai_failed")
          : code === "draft_failed"
            ? t("errors.draft_failed")
            : code === "draft_empty"
              ? t("errors.draft_empty")
              : t("errors.fetch_failed");
}

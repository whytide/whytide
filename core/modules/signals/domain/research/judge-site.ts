// The companies of a research run to judge, and each one's own site, read (README.md "Web research";
// docs/flows.md; gamma-wr-050). The queue (signals_research_judge_queue) lines up the source's pending
// candidates, the ones an earlier run left first (`pendingCandidates`), as ids in a file; the site
// step (signals_research_site), one candidate a step by its place in the queue, reads its site through
// enrichment's `readCompanySite` (robots.txt first, the browser for a page that shows nothing without
// scripts, at most SIGNALS_RESEARCH_SITE_MAX_PAGES pages) and keeps the pages as a file. A site that
// cannot be read (robots.txt closes it, or the fetch fails) drops its candidate with the reader's code,
// nothing is judged, and the candidate is not tried again within SIGNALS_RESEARCH_RECHECK_DAYS (the
// candidates' step leaves a dropped one alone that long). At the companies' limit (the companies judged
// so far told by the workflow) nothing is read and `counts.budget_reached` is set once. A step's counts
// follow its file or its row; no link, name or text reaches a log, a span, a metric or the workflow's
// history: the steps answer a status and a count.
import { tenantClient } from "@whytide/db";
import { readCompanySite } from "@whytide/enrichment";
import { SITE_CODES } from "@whytide/platform";
import { settings } from "../../settings.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import {
  addCounts,
  type RunRef,
  reserveCompanyCredit,
  settleCompanyCredit,
  writeRunFile,
} from "../runs.ts";
import { pendingCandidates } from "./candidates.ts";
import {
  COUNT_BUDGET_REACHED,
  COUNT_SITES_NOT_READ,
  JUDGE_QUEUE_FACTOR,
  SITE_UNREADABLE,
} from "./constants.ts";
import { judgeQueueKey, readJsonFile, siteKey } from "./files.ts";
import { neverFetched } from "./pages.ts";

/** How the queue step ended: the candidates lined up, or the source gone. */
export type JudgeQueued =
  | { readonly status: "queued"; readonly companies: number }
  | { readonly status: "gone" };

/** The queue's file: the candidates' ids, in the order they are judged. */
type JudgeQueue = { readonly candidates: readonly string[] };

/**
 * The site of a candidate as the judge reads it: each page's address, title, text and `mailto:`
 * addresses, and, since gamma-wr-060, the addresses it links to (`links`), which the people step's
 * profile gate reads; a file written before has none.
 */
export type SiteFile = {
  readonly candidateId: string;
  /** The company's credit, reserved before the read (gamma-wr-051); absent for an unpriced run. */
  readonly usageId?: string;
  readonly pages: readonly {
    readonly url: string;
    readonly title: string;
    readonly text: string;
    readonly mailto: readonly string[];
    readonly links?: readonly string[];
  }[];
};

/**
 * The run's queue: the source's pending candidates, oldest first (the earlier runs' before the run's
 * own), up to JUDGE_QUEUE_FACTOR times the companies' limit, since a site that cannot be read does not
 * use the limit. A step run again answers from the file.
 */
export async function queueCompanies(ref: RunRef, tenant: TenantRun): Promise<JudgeQueued> {
  const { workspaceId, runId, sourceId } = ref;
  const filed = (await readJsonFile(workspaceId, judgeQueueKey(runId))) as JudgeQueue | null;
  if (filed !== null) return { status: "queued", companies: filed.candidates.length };
  const found = await tenant(async () => {
    const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
    if (source === null) return null;
    const limit = settings.SIGNALS_RESEARCH_COMPANIES_PER_RUN * JUDGE_QUEUE_FACTOR;
    return pendingCandidates(sourceId, limit);
  });
  if (found === null) return { status: "gone" };
  const candidates = found.map(({ id }) => id);
  await writeRunFile(workspaceId, judgeQueueKey(runId), { candidates });
  return { status: "queued", companies: candidates.length };
}

/**
 * How a site step ended: read (now or by an earlier attempt), closed, failed, skipped, at the limit, refused
 * a credit (`insufficient_credits`, which ends the run), or the source gone.
 */
export type SiteStep = {
  readonly status: "read" | "closed" | "failed" | "skipped" | "budget" | "refused" | "gone";
};

/**
 * The site of the queue's `index`th candidate (from 1), `judged` companies having been judged before it
 * in this run. A fault the reader throws (no code) is thrown, for the activity's attempts. In a `priced`
 * run (gamma-wr-051) the company's credit is reserved before the read, kept with the site's file for the
 * judge step to commit, and released at once when the site cannot be read.
 */
export async function readCandidateSite(
  ref: RunRef,
  index: number,
  judged: number,
  tenant: TenantRun,
  priced = false,
): Promise<SiteStep> {
  const { workspaceId, runId } = ref;
  if (judged >= settings.SIGNALS_RESEARCH_COMPANIES_PER_RUN) {
    await tenant(() => budgetReached(runId));
    return { status: "budget" };
  }
  if ((await readJsonFile(workspaceId, siteKey(runId, index))) !== null) return { status: "read" };
  const queue = (await readJsonFile(workspaceId, judgeQueueKey(runId))) as JudgeQueue | null;
  const candidateId = queue?.candidates[index - 1];
  if (candidateId === undefined) return { status: "skipped" };
  const candidate = await tenant(() =>
    tenantClient.signalResearchCandidate.findFirst({ where: { id: candidateId } }),
  );
  if (candidate === null || candidate.state !== "pending") return { status: "skipped" };
  const unreadable = neverFetched(candidate.domain);
  let usageId: string | undefined;
  if (priced && !unreadable) {
    const credit = await tenant(() => reserveCompanyCredit(ref, candidateId));
    if ("refused" in credit) return { status: "refused" };
    usageId = credit.usageId;
  }
  const read = unreadable
    ? { ok: false as const, code: SITE_UNREADABLE }
    : await readCompanySite(candidate.domain, () => {}, undefined, {
        maxPages: settings.SIGNALS_RESEARCH_SITE_MAX_PAGES,
        refuseHost: neverFetched,
      });
  if (!read.ok) {
    await tenant(async () => {
      await tenantClient.signalResearchCandidate.updateMany({
        where: { id: candidateId, state: "pending" },
        data: { state: "dropped", dropCode: read.code, stateAt: new Date() },
      });
      await addCounts(runId, { [COUNT_SITES_NOT_READ]: 1 });
      if (usageId !== undefined) await settleCompanyCredit(usageId, false);
    });
    return { status: read.code === SITE_CODES.disallowed ? "closed" : "failed" };
  }
  const pages = read.pages.map(({ url, title, text, mailto, links }) => ({
    ...{ url, title, text, mailto },
    links: links.map(({ href }) => href),
  }));
  const file = { candidateId, ...(usageId === undefined ? {} : { usageId }), pages };
  await writeRunFile(workspaceId, siteKey(runId, index), file satisfies SiteFile);
  return { status: "read" };
}

/**
 * The credit of the company whose site was read for the run's `index`th place and not judged, released
 * when the run ends before its verdict (gamma-wr-051): a cancel, a failure or a stop between the two
 * steps. A credit settled already is left alone; no site file, or none with a credit, is nothing to do.
 */
export async function releaseOpenCompany(
  ref: RunRef,
  index: number,
  tenant: TenantRun,
): Promise<void> {
  const file = (await readJsonFile(ref.workspaceId, siteKey(ref.runId, index))) as SiteFile | null;
  const usageId = file?.usageId;
  if (usageId !== undefined) await tenant(() => settleCompanyCredit(usageId, false));
}

/** The run's `budget_reached` set once: the searches' or the pages' limit may have set it already. */
async function budgetReached(runId: string): Promise<void> {
  const row = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  const counts = (row?.counts ?? {}) as Record<string, number>;
  if (counts[COUNT_BUDGET_REACHED] === undefined)
    await addCounts(runId, { [COUNT_BUDGET_REACHED]: 1 });
}

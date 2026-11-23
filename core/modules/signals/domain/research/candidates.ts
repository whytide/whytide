// The candidates of a research run (README.md "Web research"; docs/flows.md; gamma-wr-046): the companies
// the pages named, one page a step by its place in the queue. A company named without a link gets one
// search by its name and its place, through enrichment's counted search and inside the run's searches'
// limit, and its site is taken only by the test the web-search source applies (`pickWebsite`): a
// company for which none is found is dropped, counted. Then, in one run of the workspace, each company
// is dropped before any read of its site when it is the workspace's own company or is on the never-
// contact list (a block, a customer or a competitor), else it is a candidate, `pending`: one per
// source and domain, a company the source holds already left as it is (a read or dropped one is
// re-checked after SIGNALS_RESEARCH_RECHECK_DAYS). A candidate not read stays after the run: the
// next run re-checks the pending ones against the lists (`carryCandidates`) and `pendingCandidates`
// hands them oldest first. Nothing of a company, a page or a link goes to a log, a span, a metric or
// the workflow's history: the steps answer counts.
import { type DomainStop, suppressedDomains } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { pickWebsite, searchWeb } from "@whytide/enrichment";
import { getCompanyDomain } from "@whytide/onboarding";
import { newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { settings } from "../../settings.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import { holdsContact } from "./checks.ts";
import {
  COUNT_ADAPTERS_SPENT,
  COUNT_BUDGET_REACHED,
  COUNT_CANDIDATES,
  COUNT_CANDIDATES_CARRIED,
  COUNT_CANDIDATES_KNOWN,
  COUNT_CANDIDATES_NO_SITE,
  COUNT_DROPPED_NOT_FIT,
  COUNT_DROPPED_RECENT,
  COUNT_SEARCHES_ASKED,
  COUNT_SEARCHES_FAILED,
  COUNT_SEARCHES_REFUSED_CONTACT,
  countDropped,
  DAY_MS,
  type DropCode,
  NAME_SEARCH_RESULTS,
} from "./constants.ts";
import { namedKey, readJsonFile } from "./files.ts";
import { notFitDomains } from "./not-fit.ts";
import type { NamedFile } from "./read.ts";

/** How a candidates' step ended: the companies made candidates, or why the page had none to make. */
export type CandidatesStep =
  | { readonly status: "made"; readonly made: number }
  | { readonly status: "skipped" | "gone" };

/** A company of a page's file as the step works on it: `searched` once its site was looked for. */
type Named = NamedFile["companies"][number];

/**
 * The candidates of the run's `index`th page (signals_research_candidates). A step run again finds the
 * searches it made in the file and the rows it wrote by the run's id, and adds nothing twice.
 */
export async function makeCandidates(
  ref: RunRef,
  index: number,
  tenant: TenantRun,
): Promise<CandidatesStep> {
  const { workspaceId, runId, sourceId } = ref;
  const key = namedKey(runId, index);
  const file = (await readJsonFile(workspaceId, key)) as NamedFile | null;
  if (file === null) return { status: "skipped" };
  if (!(await tenant(() => sourceExists(sourceId)))) return { status: "gone" };
  const companies = [...file.companies];
  let stopped = false;
  for (const [at, company] of companies.entries()) {
    if (company.domain !== null || company.searched === true) continue;
    const found = stopped ? { domain: null } : await searchSite(ref, company, tenant);
    if (found.stop === true) stopped = true;
    if (found.domain === null)
      await tenant(() => addCounts(runId, { [COUNT_CANDIDATES_NO_SITE]: 1 }));
    companies[at] = { ...company, domain: found.domain, searched: true };
    await writeRunFile(workspaceId, key, { ...file, companies });
  }
  const made = await tenant(() => keepCandidates(ref, file, companies));
  return { status: "made", made };
}

/** Whether the run's source is still there. */
async function sourceExists(sourceId: string): Promise<boolean> {
  return (await tenantClient.signalSource.findFirst({ where: { id: sourceId } })) !== null;
}

/**
 * The company's site by one search of its name and its place: its domain, or null for none (no
 * adapter, a failed search, a query that holds contact data, or no site that passes `pickWebsite`);
 * `stop` when no more searches are to be asked: the run's searches are at their limit (counted
 * `budget_reached`, once) or every adapter is spent (counted). The search is counted as the plan's
 * searches are, so that the limit holds for both.
 */
async function searchSite(
  { runId }: RunRef,
  company: Named,
  tenant: TenantRun,
): Promise<{ readonly domain: string | null; readonly stop?: true }> {
  const quoted = `"${company.name.replaceAll('"', "")}"`;
  const query = company.place === null ? quoted : `${quoted} ${company.place}`;
  const room = await tenant(() => searchRoom(runId));
  if (!room) return { domain: null, stop: true };
  if (holdsContact(query)) {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_REFUSED_CONTACT]: 1 }));
    return { domain: null };
  }
  const searched = await searchWeb({ query, count: NAME_SEARCH_RESULTS });
  if (searched.status === "no_adapter") return { domain: null };
  if (searched.status === "spent") {
    await tenant(() => addCounts(runId, { [COUNT_ADAPTERS_SPENT]: 1 }));
    return { domain: null, stop: true };
  }
  if (searched.status === "failed") {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_FAILED]: 1 }));
    return { domain: null };
  }
  await tenant(() => addCounts(runId, { [COUNT_SEARCHES_ASKED]: 1 }));
  const picked = pickWebsite(company.name, searched.results);
  return { domain: picked.found };
}

/** Whether the run may ask one more search; at the limit it sets `budget_reached` once. */
export async function searchRoom(runId: string): Promise<boolean> {
  const run = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  const counts = (run?.counts ?? {}) as Record<string, number>;
  const used = (counts[COUNT_SEARCHES_ASKED] ?? 0) + (counts[COUNT_SEARCHES_FAILED] ?? 0);
  if (used < settings.SIGNALS_RESEARCH_SEARCHES_PER_RUN) return true;
  if (counts[COUNT_BUDGET_REACHED] === undefined)
    await addCounts(runId, { [COUNT_BUDGET_REACHED]: 1 });
  return false;
}

/** Whether the candidate's domain is the workspace's own company's, or a subdomain of it. */
const isOwn = (domain: string, own: string | null): boolean =>
  own !== null && (domain === own || domain.endsWith(`.${own}`));

/**
 * The drop a domain gets, or null for none: the workspace's own company, else the never-contact list's,
 * else a company a member marked Not a fit for the source (gamma-wr-110).
 */
function dropOf(
  domain: string,
  own: string | null,
  stops: ReadonlyMap<string, DomainStop>,
  marked: ReadonlySet<string> = new Set(),
): DropCode | null {
  if (isOwn(domain, own)) return "own_company";
  return stops.get(domain) ?? (marked.has(domain) ? "not_fit" : null);
}

/**
 * The companies of the page kept as rows, in the caller's run of the workspace: the counts and the
 * rows written together. A company with no site is counted, when its search ends, and kept nowhere; one the source holds
 * already is counted known (pending) or recent (read or dropped within the re-check days, which the
 * stamp `state_at` counts from) and left; an older read or dropped one is decided again; a row the
 * run itself made, by an earlier attempt or from another page, is left without a count.
 */
async function keepCandidates(
  { runId, sourceId, workspaceId }: RunRef,
  file: NamedFile,
  companies: readonly Named[],
): Promise<number> {
  const counts: Record<string, number> = {};
  const add = (name: string) => {
    counts[name] = (counts[name] ?? 0) + 1;
  };
  const withSite = companies.flatMap((company) =>
    company.domain === null ? [] : [{ ...company, domain: company.domain }],
  );
  const domains = [...new Set(withSite.map(({ domain }) => domain))];
  if (domains.length === 0) {
    await addCounts(runId, counts);
    return 0;
  }
  const own = await getCompanyDomain();
  const stops = await suppressedDomains(domains);
  const marked = await notFitDomains(sourceId, domains);
  const rows = await tenantClient.signalResearchCandidate.findMany({
    where: { sourceId, domain: { in: domains } },
  });
  const held = new Map(rows.map((row) => [row.domain, row]));
  const now = new Date();
  const recheck = settings.SIGNALS_RESEARCH_RECHECK_DAYS * DAY_MS;
  let made = 0;
  const done = new Set<string>();
  for (const company of withSite) {
    const { domain } = company;
    const row = held.get(domain);
    if (done.has(domain) || (row !== undefined && row.runId === runId)) continue;
    done.add(domain);
    // Not a fit wins over every re-check: the company is never read or judged again for this source.
    if (marked.has(domain)) {
      add(COUNT_DROPPED_NOT_FIT);
      continue;
    }
    if (row?.state === "pending") {
      add(COUNT_CANDIDATES_KNOWN);
      continue;
    }
    if (row !== undefined && now.getTime() - row.stateAt.getTime() < recheck) {
      add(COUNT_DROPPED_RECENT);
      continue;
    }
    const drop = dropOf(domain, own, stops);
    const data = {
      ...{ runId, name: company.name, place: company.place, pageUrl: file.pageUrl },
      ...{ placeId: file.placeId, queryId: file.queryId ?? null },
      ...{ line: company.line, quote: company.quote },
      ...{ state: drop === null ? ("pending" as const) : ("dropped" as const) },
      ...{ dropCode: drop, stateAt: now },
    };
    if (row === undefined) {
      const id = newId(ids.signal_research_candidate);
      await tenantClient.signalResearchCandidate.create({
        data: { id, workspaceId, sourceId, domain, ...data },
      });
    } else {
      await tenantClient.signalResearchCandidate.update({ where: { id: row.id }, data });
    }
    if (drop === null) {
      add(COUNT_CANDIDATES);
      made += 1;
    } else add(countDropped(drop));
  }
  await addCounts(runId, counts);
  return made;
}

/**
 * The run's first candidate step (signals_research_carry): the candidates the source's earlier runs left
 * pending are checked against the lists again, since a list may have changed since: one that is now
 * the workspace's own company or on the never-contact list is dropped with its code and counted; the
 * rest are counted `candidates_carried`, and `pendingCandidates` reads them before the run's own.
 */
export async function carryCandidates(
  { runId, sourceId }: RunRef,
  tenant: TenantRun,
): Promise<{ readonly carried: number }> {
  return tenant(async () => {
    const pending = await tenantClient.signalResearchCandidate.findMany({
      where: { sourceId, state: "pending", NOT: { runId } },
    });
    if (pending.length === 0) return { carried: 0 };
    const own = await getCompanyDomain();
    const domains = pending.map(({ domain }) => domain);
    const stops = await suppressedDomains(domains);
    const marked = await notFitDomains(sourceId, domains);
    const counts: Record<string, number> = {};
    const now = new Date();
    let carried = 0;
    for (const { id, domain } of pending) {
      const drop = dropOf(domain, own, stops, marked);
      if (drop === null) {
        carried += 1;
        continue;
      }
      await tenantClient.signalResearchCandidate.update({
        where: { id },
        data: { state: "dropped", dropCode: drop, stateAt: now },
      });
      counts[countDropped(drop)] = (counts[countDropped(drop)] ?? 0) + 1;
    }
    await addCounts(runId, { ...counts, [COUNT_CANDIDATES_CARRIED]: carried });
    return { carried };
  });
}

/** A candidate as the next task reads it. */
export type PendingCandidate = {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly place: string | null;
  readonly pageUrl: string;
  readonly placeId: string | null;
  readonly line: string | null;
  readonly quote: string | null;
};

/**
 * The source's candidates not read yet, oldest first: the ones an earlier run left come before the
 * ones the run found, since a run's candidates are all newer. In the caller's run of the workspace.
 */
export async function pendingCandidates(
  sourceId: string,
  limit?: number,
): Promise<PendingCandidate[]> {
  const rows = await tenantClient.signalResearchCandidate.findMany({
    where: { sourceId, state: "pending" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    ...(limit === undefined ? {} : { take: limit }),
  });
  return rows.map(({ id, name, domain, place, pageUrl, placeId, line, quote }) => ({
    ...{ id, name, domain, place, pageUrl, placeId, line, quote },
  }));
}

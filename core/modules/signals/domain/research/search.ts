// A research run's search (README.md "Web research"; docs/flows.md; gamma-wr-041): one query of the
// run's plan a step, in the plan's order, through enrichment's counted search with the query's country
// and language, 10 results, page 1. The answer goes to the files port under raw/signals/<runId>/search/
// (raw/'s 72 hours; gamma-wr-045 reads it) and the query gets its asked_at and result count in the same
// step: a step run again finds the file and writes the row, never searching twice. A query that holds
// an email address, a link or a phone number is refused before it is searched; a search that fails is
// counted and skipped. Nothing of a query or a result goes to a log, a span, a metric or the
// workflow's history: the step answers a status.
import { json } from "node:stream/consumers";
import { tenantClient } from "@whytide/db";
import { searchWeb } from "@whytide/enrichment";
import { isAppError } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { settings } from "../../settings.ts";
import { runFolder } from "../process/keys.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import { holdsContact } from "./checks.ts";
import {
  COUNT_ADAPTERS_SPENT,
  COUNT_BUDGET_REACHED,
  COUNT_SEARCH_RESULTS,
  COUNT_SEARCHES_ASKED,
  COUNT_SEARCHES_FAILED,
  COUNT_SEARCHES_REFUSED_CONTACT,
  SEARCH_PAGE,
  SEARCH_RESULTS_COUNT,
} from "./constants.ts";

/**
 * How a search step ended. `asked`, `failed`, `refused` and `skipped` (asked already, or no such
 * query) go on to the next query; `budget` and `spent` end the run `done`; `unavailable` (no search
 * adapter loaded) ends it `failed`; `gone` is a source gone.
 */
export type Searched = {
  readonly status:
    | "asked"
    | "failed"
    | "refused"
    | "skipped"
    | "budget"
    | "spent"
    | "unavailable"
    | "gone";
};

type Query = { readonly id: string; readonly text: string } & Record<
  "placeId" | "country" | "language",
  string
>;
type Read = Searched | { readonly status: "ready"; readonly query: Query };

/** The answer file of the run's `position`th query. */
export const searchKey = (runId: string, position: number): string =>
  `${runFolder(runId)}search/${position}.json`;

/**
 * The step of the run's `position`th query (from 1). Before the search: a query asked already is
 * skipped, the run's searches at the limit end it (`counts.budget_reached`), and a query that holds
 * a contact is refused, counted by the gate's name.
 */
export async function searchResearchQuery(
  ref: RunRef,
  position: number,
  tenant: TenantRun,
): Promise<Searched> {
  const read = await tenant(() => readQuery(ref, position));
  if (read.status !== "ready") return read;
  const { workspaceId, runId } = ref;
  const { query } = read;
  const key = searchKey(runId, position);
  let results = await filed(workspaceId, key);
  if (results === null) {
    const searched = await searchWeb({
      query: query.text,
      count: SEARCH_RESULTS_COUNT,
      country: query.country,
      language: query.language,
      page: SEARCH_PAGE,
    });
    if (searched.status === "no_adapter") return { status: "unavailable" };
    if (searched.status === "spent") {
      await tenant(() => addCounts(runId, { [COUNT_ADAPTERS_SPENT]: 1 }));
      return { status: "spent" };
    }
    if (searched.status === "failed") {
      await tenant(() => addCounts(runId, { [COUNT_SEARCHES_FAILED]: 1 }));
      return { status: "failed" };
    }
    results = searched.results.length;
    const { placeId, country, language } = query;
    const body = {
      placeId,
      country,
      language,
      adapter: searched.adapter,
      results: searched.results,
    };
    await writeRunFile(workspaceId, key, body);
  }
  const resultCount = results;
  await tenant(() => keep(ref, query.id, resultCount));
  return { status: "asked" };
}

/** The query of the position, whether it can be asked, and the run's counts changed for the end it is. */
async function readQuery({ sourceId, runId }: RunRef, position: number): Promise<Read> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return { status: "gone" };
  const plan = await tenantClient.signalResearchPlan.findFirst({ where: { runId } });
  if (plan === null) return { status: "skipped" };
  const row = await tenantClient.signalResearchQuery.findFirst({
    where: { planId: plan.id, position },
  });
  if (row === null) return { status: "skipped" };
  const run = await tenantClient.signalRun.findFirst({ where: { id: runId } });
  const counts = (run?.counts ?? {}) as Record<string, number>;
  // A query asked by an attempt before this one (its file written, its row not yet) is finished below.
  if (row.askedAt !== null) return { status: "skipped" };
  const used = (counts[COUNT_SEARCHES_ASKED] ?? 0) + (counts[COUNT_SEARCHES_FAILED] ?? 0);
  if (used >= settings.SIGNALS_RESEARCH_SEARCHES_PER_RUN) {
    if (counts[COUNT_BUDGET_REACHED] === undefined)
      await addCounts(runId, { [COUNT_BUDGET_REACHED]: 1 });
    return { status: "budget" };
  }
  if (holdsContact(row.text)) {
    await addCounts(runId, { [COUNT_SEARCHES_REFUSED_CONTACT]: 1 });
    return { status: "refused" };
  }
  const { id, text, placeId, country, language } = row;
  return { status: "ready", query: { id, text, placeId, country, language } };
}

/** The query's asked_at and result count, and the run's counts, once: a step run again adds nothing. */
async function keep({ runId }: RunRef, queryId: string, resultCount: number): Promise<void> {
  const marked = await tenantClient.signalResearchQuery.updateMany({
    where: { id: queryId, askedAt: null },
    data: { askedAt: new Date(), resultCount },
  });
  if (marked.count === 0) return;
  await addCounts(runId, { [COUNT_SEARCHES_ASKED]: 1, [COUNT_SEARCH_RESULTS]: resultCount });
}

/** The results' count of an answer file a step before wrote, or null when there is none. */
async function filed(workspaceId: string, key: string): Promise<number | null> {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  try {
    const body = await json((await files.get({ workspaceId, key })).body);
    const { results } = body as { results?: unknown };
    return Array.isArray(results) ? results.length : 0;
  } catch (error) {
    if (isAppError(error) && error.code === filesPort.errors.files_not_found) return null;
    throw error;
  }
}

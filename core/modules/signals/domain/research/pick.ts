// The pick among a search's results (README.md "Web research"; docs/flows.md; gamma-wr-045), one search
// a step after the searches, by its position: the answer file the search kept is read, a result on
// LinkedIn or on a host never fetched is dropped in code, the rest go to the agent
// signals.research-pick-results, which answers the ones worth reading, the likeliest first; its answer
// is gated (picksGate: a number that is no result is refused), cut to PICKS_PER_SEARCH and kept as
// raw/signals/<runId>/pick/<position>.json. A step run again finds the file and answers from it. The
// model is asked outside any run, between two runs. Nothing of a result, a query or a link goes to a
// log, a span, a metric or the workflow's history: the step answers a status and a count.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import { AppError, isAppError } from "@whytide/platform";
import type { WebResult } from "@whytide/providers";
import type { researchPickResultsTask } from "../../agents/research-pick-results/task.ts";
import { errors } from "../../errors.ts";
import {
  RESEARCH_PICK_RESULTS,
  type ResearchPickInput,
} from "../../schemas/research-pick-results.ts";
import type { WebResearchConfig } from "../../sources/web_research/index.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import {
  COUNT_PAGES_PICKED,
  COUNT_PICKS_FAILED,
  COUNT_RESULTS_DROPPED,
  INPUT_TEXT_MAX,
  PICKS_PER_SEARCH,
  RESULT_SNIPPET_CHARS,
  RESULT_TITLE_CHARS,
  RESULT_URL_CHARS,
} from "./constants.ts";
import { pickKey, readJsonFile } from "./files.ts";
import { pageUrlOf } from "./pages.ts";
import { placeOf } from "./places/registry.ts";
import { searchKey } from "./search.ts";
import { clean, fit } from "./text.ts";

/**
 * How a pick step ended: `picked` with the number of results kept (0 too), `none` for a query never
 * asked (no answer file), `failed` when the model could not answer (its schema or its gate failed
 * twice, or the call went over its budget) so that the search's pages are not read, `gone` for a
 * source gone.
 */
export type PickStep =
  | { readonly status: "picked"; readonly picked: number }
  | { readonly status: "none" | "failed" | "gone" };

/** What the step keeps for the queue: the search's source type and the addresses picked, the likeliest first. */
type PickFile = {
  readonly placeId: string;
  readonly urls: readonly string[];
  /** The query's row, so that the plan can count the companies each query led to (gamma-wr-051). */
  readonly queryId?: string;
};
/** The query and the source's words, read in one tenant run. */
type Read = {
  readonly queryId: string;
  readonly focus: string;
  readonly region: string;
  readonly query: { place: string; country: string; language: string; text: string };
};

/**
 * The pick of the run's `position`th search (signals_research_pick). The decision record's subject is
 * the source. An llm_* code throws, for the activity's attempts.
 */
export async function pickResearchResults(
  ref: RunRef,
  position: number,
  tenant: TenantRun,
): Promise<PickStep> {
  const { workspaceId, runId, sourceId } = ref;
  const filed = (await readJsonFile(workspaceId, pickKey(runId, position))) as PickFile | null;
  if (filed !== null) return { status: "picked", picked: filed.urls.length };
  const answer = await readJsonFile(workspaceId, searchKey(runId, position));
  if (answer === null) return { status: "none" };
  const read = await tenant(() => readQuery(ref, position));
  if (read === null) return { status: "gone" };
  const place = placeOf(read.query.place);
  const given = (answer as { results?: WebResult[] }).results ?? [];
  const results = given.flatMap((result) => {
    const url = pageUrlOf(result.url);
    return url === null ? [] : [{ ...result, url }];
  });
  const dropped = given.length - results.length;
  if (place === undefined || results.length === 0) {
    await keep(
      ref,
      position,
      { placeId: read.query.place, urls: [], queryId: read.queryId },
      dropped,
      tenant,
    );
    return { status: "picked", picked: 0 };
  }
  const task = registeredTask();
  const input: ResearchPickInput = {
    source: { focus: read.focus, region: read.region },
    query: read.query,
    place: { shows: place.shows, finding: place.finding, pageKind: place.pageKind },
    results: results.map(({ url, title, snippet }, at) => ({
      index: at + 1,
      url: fit(url, RESULT_URL_CHARS),
      title: clean(title, RESULT_TITLE_CHARS),
      snippet: clean(snippet, RESULT_SNIPPET_CHARS),
    })),
  };
  const client = givenClient();
  const call = { workspaceId, subjectRef: sourceId, input };
  const result = await callAgent(task, call, client === undefined ? {} : { client }).catch(
    (error: unknown) => {
      if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
      throw error;
    },
  );
  if (result === null || result.status !== "ok") {
    await tenant(() => addCounts(runId, { [COUNT_PICKS_FAILED]: 1 }));
    return { status: "failed" };
  }
  const urls = result.output.picks
    .slice(0, PICKS_PER_SEARCH)
    .flatMap(({ index }) => results[index - 1]?.url ?? []);
  await keep(
    ref,
    position,
    { placeId: read.query.place, urls, queryId: read.queryId },
    dropped,
    tenant,
  );
  return { status: "picked", picked: urls.length };
}

/** The file first, then the counts: a step that fails between them leaves the counts one short. */
async function keep(
  { workspaceId, runId }: RunRef,
  position: number,
  file: PickFile,
  dropped: number,
  tenant: TenantRun,
): Promise<void> {
  await writeRunFile(workspaceId, pickKey(runId, position), file);
  const counts = { [COUNT_PAGES_PICKED]: file.urls.length, [COUNT_RESULTS_DROPPED]: dropped };
  await tenant(() => addCounts(runId, counts));
}

/** The source's words and the run's `position`th query; null for a source or a query gone. */
async function readQuery({ sourceId, runId }: RunRef, position: number): Promise<Read | null> {
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return null;
  const plan = await tenantClient.signalResearchPlan.findFirst({ where: { runId } });
  if (plan === null) return null;
  const row = await tenantClient.signalResearchQuery.findFirst({
    where: { planId: plan.id, position },
  });
  if (row === null) return null;
  const config = source.config as WebResearchConfig;
  return {
    queryId: row.id,
    focus: clean(config.focus, INPUT_TEXT_MAX),
    region: clean(config.region ?? "", INPUT_TEXT_MAX),
    query: { place: row.placeId, country: row.country, language: row.language, text: row.text },
  };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof researchPickResultsTask {
  const task = registeredAgentTasks().get(RESEARCH_PICK_RESULTS);
  if (task === undefined) throw new AppError(errors.signal_research_pick_agent_not_loaded);
  return task as unknown as typeof researchPickResultsTask;
}

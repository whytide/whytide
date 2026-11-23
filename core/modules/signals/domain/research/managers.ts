// A found company's managers by search (README.md "Web research"; docs/flows.md; gamma-wr-090), a part of
// the people step (people.ts). For a `fit` company whose pages gave fewer picked people than
// SIGNALS_RESEARCH_PEOPLE_PER_COMPANY, one web search for its managers on LinkedIn: the company's name
// and the plan's role words of the search's language, never a person's name (the second exception of
// 2026-11-16 holds a name only in people-profile.ts's own search), limited to linkedin.com, with the
// company's country, 10 results, through enrichment's counted search and inside the run's searches'
// limit. Which result is a profile's is decided in code (managers-checks.ts, compared and never
// fetched: no request goes to linkedin.com); the agent signals.research-read-result then reads the
// name and the role each kept result gives (extraction), and its answer is gated in code. The
// people the pages gave already are left out; the pick (people.ts) judges the rest on roles alone.
// Names stay in memory: the query, the results and the people are in no log line, span, metric or
// history, and the results are the run's files (raw/, 72 hours), read again by a step run again, which
// never searches twice. The read's decision record has the workspace as its subject, so that the
// deletion of any person removes it, as the pages' people reading's.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { searchWeb } from "@whytide/enrichment";
import { AppError, isAppError } from "@whytide/platform";
import type { WebResult } from "@whytide/providers";
import type { researchReadResultTask } from "../../agents/research-read-result/task.ts";
import { errors } from "../../errors.ts";
import { RESEARCH_READ_RESULT } from "../../schemas/research-read-result.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import { searchRoom } from "./candidates.ts";
import { holdsContact } from "./checks.ts";
import {
  COUNT_ADAPTERS_SPENT,
  COUNT_MANAGERS_PEOPLE,
  COUNT_MANAGERS_READS_FAILED,
  COUNT_MANAGERS_RESULTS,
  COUNT_MANAGERS_SEARCHES,
  COUNT_SEARCHES_ASKED,
  COUNT_SEARCHES_FAILED,
  COUNT_SEARCHES_REFUSED_CONTACT,
  countManagersRefused,
  MANAGERS_GATES,
  MANAGERS_RESULTS_COUNT,
  PROFILE_SITE,
} from "./constants.ts";
import { managersKey, readJsonFile } from "./files.ts";
import {
  gateManagers,
  type ManagerPerson,
  type ManagerResult,
  managerResultsOf,
  managersQuery,
  type RoleWords,
  withoutPagePeople,
  wordsForSearch,
} from "./managers-checks.ts";
import type { GatedPerson } from "./people-checks.ts";

/** Whom to look for the managers of: the found company, its name and country, the plan's role words. */
export type ManagersAsk = {
  readonly foundCompanyId: string;
  readonly companyName: string;
  readonly country: string | null;
  readonly roleWords: RoleWords;
  /** The language of the query that led to the company; its role words are asked first. */
  readonly language: string | null;
};

/**
 * What the managers' step gave: the people, with the counts to add to the run's (the step's own tenant
 * run adds them); null when the model could not answer, so that a later run asks again.
 */
export type ManagersTaken = {
  readonly people: readonly ManagerPerson[];
  readonly counts: Readonly<Record<string, number>>;
} | null;

/** The kept results of the search, or none: a search not asked, refused, failed or spent gives none. */
type Searched = { readonly results: readonly ManagerResult[] };

const NONE: Searched = { results: [] };

/**
 * The search of the company's managers. A file the step wrote before answers without a search; else the
 * run's searches' limit is read (`budget_reached` is set once at it), the query is refused when it holds
 * a contact, and the counted search is asked once, its results kept as a file.
 */
async function searchManagers(
  ref: RunRef,
  ask: ManagersAsk,
  words: readonly string[],
  tenant: TenantRun,
): Promise<Searched> {
  const { workspaceId, runId } = ref;
  const key = managersKey(runId, ask.foundCompanyId);
  const filed = (await readJsonFile(workspaceId, key)) as { results?: WebResult[] } | null;
  if (filed !== null) return { results: managerResultsOf(filed.results ?? [], ask.companyName) };
  if (!(await tenant(() => searchRoom(runId)))) return NONE;
  const query = managersQuery(ask.companyName, words);
  if (holdsContact(query)) {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_REFUSED_CONTACT]: 1 }));
    return NONE;
  }
  const searched = await searchWeb({
    ...{ query, site: PROFILE_SITE, count: MANAGERS_RESULTS_COUNT },
    ...(ask.country === null ? {} : { country: ask.country }),
  });
  if (searched.status === "no_adapter") return NONE;
  if (searched.status === "spent") {
    await tenant(() => addCounts(runId, { [COUNT_ADAPTERS_SPENT]: 1 }));
    return NONE;
  }
  if (searched.status === "failed") {
    await tenant(() => addCounts(runId, { [COUNT_SEARCHES_FAILED]: 1 }));
    return NONE;
  }
  await writeRunFile(workspaceId, key, { adapter: searched.adapter, results: searched.results });
  const results = managerResultsOf(searched.results, ask.companyName);
  await tenant(() =>
    addCounts(runId, {
      [COUNT_SEARCHES_ASKED]: 1,
      [COUNT_MANAGERS_SEARCHES]: 1,
      [COUNT_MANAGERS_RESULTS]: results.length,
    }),
  );
  return { results };
}

/**
 * The company's managers by search: the people the kept results give, gated, without the people the
 * pages named already. No people for a plan with no role words; null when the model could not answer.
 * An llm_* code throws, for the activity's attempts.
 */
export async function takeManagers(
  ref: RunRef,
  ask: ManagersAsk,
  pagePeople: readonly Pick<GatedPerson, "name" | "profile">[],
  tenant: TenantRun,
): Promise<ManagersTaken> {
  const words = wordsForSearch(ask.roleWords, ask.language);
  if (words === null) return { people: [], counts: {} };
  const searched = await searchManagers(ref, ask, words, tenant);
  if (searched.results.length === 0) return { people: [], counts: {} };
  const output = await readResults(ref, ask.companyName, searched.results);
  if (output === null) {
    await tenant(() => addCounts(ref.runId, { [COUNT_MANAGERS_READS_FAILED]: 1 }));
    return null;
  }
  const gated = gateManagers(output, searched.results);
  const people = withoutPagePeople(gated.people, pagePeople);
  const counts: Record<string, number> = { [COUNT_MANAGERS_PEOPLE]: people.length };
  for (const gate of MANAGERS_GATES) counts[countManagersRefused(gate)] = gated.refused[gate] ?? 0;
  return { people, counts };
}

/** The model's answer for the kept results; null when its schema failed twice or the call went over its budget. */
async function readResults(ref: RunRef, companyName: string, results: readonly ManagerResult[]) {
  const input = {
    company: { name: companyName },
    results: results.map(({ n, title, snippet }) => ({ n, title, snippet })),
  };
  // The workspace is the subject, so that a person's erasure deletes the record (evidence.ts).
  const call = { workspaceId: ref.workspaceId, subjectRef: ref.workspaceId, input };
  const client = givenClient();
  const result = await callAgent(readTask(), call, client === undefined ? {} : { client }).catch(
    (error: unknown) => {
      if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
      throw error;
    },
  );
  return result === null || result.status !== "ok" ? null : result.output;
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function readTask(): typeof researchReadResultTask {
  const task = registeredAgentTasks().get(RESEARCH_READ_RESULT);
  if (task === undefined) throw new AppError(errors.signal_research_people_agent_not_loaded);
  return task as unknown as typeof researchReadResultTask;
}

// What a page the run read is (README.md "Web research"; docs/flows.md; gamma-wr-046), one page a step,
// by its place in the queue: the page's file is read, the agent signals.research-read-page says what
// the page is and which companies it names, and the gates (read-checks.ts) keep only what the page
// holds. The companies go to the files port as raw/signals/<runId>/candidates/<n>.json, which the
// candidates' step reads (candidates.ts); a page that names none is an empty file. A step run again
// finds the file and calls the model no more. The model is asked outside any run, between two runs.
// Nothing of a page, a company or a quote goes to a log, a span, a metric or the workflow's history:
// the step answers a status and a count.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import { AppError, isAppError } from "@whytide/platform";
import type { researchReadPageTask } from "../../agents/research-read-page/task.ts";
import { errors } from "../../errors.ts";
import { RESEARCH_READ_PAGE, type ResearchReadInput } from "../../schemas/research-read-page.ts";
import type { WebResearchConfig } from "../../sources/web_research/index.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, writeRunFile } from "../runs.ts";
import {
  COUNT_PAGES_EMPTY,
  COUNT_READS_FAILED,
  countRefused,
  INPUT_TEXT_MAX,
  PAGE_LINK_CHARS,
  PAGE_LINKS_MAX,
  PAGE_TEXT_INPUT_CHARS,
  PAGE_TITLE_INPUT_CHARS,
  READ_GATES,
} from "./constants.ts";
import { namedKey, pageKey, readJsonFile } from "./files.ts";
import { neverFetched } from "./pages.ts";
import { placeOf } from "./places/registry.ts";
import { type GatedCompany, gateRead } from "./read-checks.ts";
import { clean, fit } from "./text.ts";

/**
 * How a read step ended: `read` with the companies kept (0 for a page that names none), `failed` when
 * the model could not answer (its schema failed twice, or the call went over its budget), `skipped`
 * for a page that was not read, `gone` for a source gone.
 */
export type NamedStep =
  | { readonly status: "read"; readonly companies: number }
  | { readonly status: "failed" | "skipped" | "gone" };

/** A page file as part 1 kept it (page.ts), read loosely. */
type PageFile = {
  readonly url: string;
  readonly finalUrl: string;
  readonly placeId: string | null;
  readonly queryId?: string;
  readonly title: string;
  readonly text: string;
  readonly links: readonly { readonly href: string }[];
};

/** What the step keeps for the candidates' step: the page's address and source type, and the companies. */
export type NamedFile = {
  readonly pageUrl: string;
  readonly placeId: string | null;
  readonly queryId?: string;
  readonly companies: readonly (GatedCompany & { searched?: boolean })[];
};

/**
 * The companies the run's `index`th page names (signals_research_read). The decision record's subject
 * is the source. An llm_* code throws, for the activity's attempts.
 */
export async function readPageCompanies(
  ref: RunRef,
  index: number,
  tenant: TenantRun,
): Promise<NamedStep> {
  const { workspaceId, runId, sourceId } = ref;
  const filed = (await readJsonFile(workspaceId, namedKey(runId, index))) as NamedFile | null;
  if (filed !== null) return { status: "read", companies: filed.companies.length };
  const page = (await readJsonFile(workspaceId, pageKey(runId, index))) as PageFile | null;
  if (page === null) return { status: "skipped" };
  const source = await tenant(() =>
    tenantClient.signalSource.findFirst({ where: { id: sourceId } }),
  );
  if (source === null) return { status: "gone" };
  const config = source.config as WebResearchConfig;
  const place = page.placeId === null ? undefined : placeOf(page.placeId);
  const hrefs = [...new Set(page.links.map(({ href }) => href))];
  const input: ResearchReadInput = {
    source: {
      focus: clean(config.focus, INPUT_TEXT_MAX),
      region: clean(config.region ?? "", INPUT_TEXT_MAX),
    },
    place: place === undefined ? null : { shows: place.shows, pageKind: place.pageKind },
    page: {
      address: addressOf(page.finalUrl),
      title: clean(page.title, PAGE_TITLE_INPUT_CHARS),
      text: clean(page.text, PAGE_TEXT_INPUT_CHARS),
      links: hrefs
        .filter((href) => href.length <= PAGE_LINK_CHARS && !neverFetched(hostOf(href)))
        .slice(0, PAGE_LINKS_MAX),
    },
  };
  const result = await call(registeredTask(), sourceId, workspaceId, input);
  if (result === null) {
    await tenant(() => addCounts(runId, { [COUNT_READS_FAILED]: 1 }));
    return { status: "failed" };
  }
  const links = hrefs;
  const gated = gateRead(result, { ...page, links });
  const body: NamedFile = {
    pageUrl: page.finalUrl,
    placeId: page.placeId,
    ...(page.queryId === undefined ? {} : { queryId: page.queryId }),
    companies: gated.companies,
  };
  await writeRunFile(workspaceId, namedKey(runId, index), body);
  const counts: Record<string, number> = {};
  for (const gate of READ_GATES) counts[countRefused(gate)] = gated.refused[gate] ?? 0;
  if (gated.companies.length === 0) counts[COUNT_PAGES_EMPTY] = 1;
  await tenant(() => addCounts(runId, counts));
  return { status: "read", companies: gated.companies.length };
}

/** The model's answer, or null when it failed twice or went over its budget; another failure is thrown. */
async function call(
  task: typeof researchReadPageTask,
  sourceId: string,
  workspaceId: string,
  input: ResearchReadInput,
) {
  const client = givenClient();
  const result = await callAgent(
    task,
    { workspaceId, subjectRef: sourceId, input },
    client === undefined ? {} : { client },
  ).catch((error: unknown) => {
    if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
    throw error;
  });
  return result === null || result.status !== "ok" ? null : result.output;
}

/** The page's address without its query and fragment: a query may hold a person's address or an id. */
function addressOf(address: string): string {
  const url = URL.parse(address);
  return url === null ? "" : fit(`${url.origin}${url.pathname}`, PAGE_LINK_CHARS * 3);
}
const hostOf = (address: string): string => URL.parse(address)?.hostname ?? "";

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof researchReadPageTask {
  const task = registeredAgentTasks().get(RESEARCH_READ_PAGE);
  if (task === undefined) throw new AppError(errors.signal_research_read_agent_not_loaded);
  return task as unknown as typeof researchReadPageTask;
}

// The judgment of a company a research run found (README.md "Web research"; docs/flows.md;
// gamma-wr-050), one company a step by its place in the run's queue: the pages of its own site, read
// by the step before (judge-site.ts), go with the source's focus, the audience's lists and what the page
// that named it said, to the agent signals.research-judge-company, asked outside any run between two
// runs; its answers are gated in code (judge-checks.ts), which keeps what the pages hold, and the verdict
// is decided by code (verdict.ts). The gated answers, the verdict and the reasons go to the files port as
// raw/signals/<runId>/verdict/<n>.json (a step run again finds the file and calls the model no more);
// then, in one tenant run, the company is kept (found.ts). A call the model fails twice (its schema, or
// over its budget) drops the candidate with the code `judge_failed`: it is not tried again within
// SIGNALS_RESEARCH_RECHECK_DAYS. Nothing of a company, a quote or a page reaches a log, a span, a metric
// or the workflow's history: the step answers a status and a verdict.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import { AppError, isAppError } from "@whytide/platform";
import type { researchJudgeCompanyTask } from "../../agents/research-judge-company/task.ts";
import { errors } from "../../errors.ts";
import {
  RESEARCH_JUDGE_COMPANY,
  type ResearchJudgeInput,
} from "../../schemas/research-judge-company.ts";
import type { WebResearchConfig } from "../../sources/web_research/index.ts";
import { audienceOf } from "../agents.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef, settleCompanyCredit, writeRunFile } from "../runs.ts";
import {
  COUNT_JUDGES_FAILED,
  CRITERIA_MAX,
  CRITERION_CHARS,
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  INPUT_TEXT_MAX,
  JUDGE_FAILED,
  REASON_LINE_CHARS,
  REASON_QUOTE_CHARS,
  SITE_PAGE_TEXT_CHARS,
  SITE_PAGE_TITLE_CHARS,
  SITE_PAGES_MAX,
  SITE_TEXT_TOTAL_CHARS,
  type Verdict,
} from "./constants.ts";
import { readJsonFile, siteKey, verdictKey } from "./files.ts";
import { keepFoundCompany, type Verdicted } from "./found.ts";
import { gateJudgment, type SitePageFacts } from "./judge-checks.ts";
import type { SiteFile } from "./judge-site.ts";
import { clean, fit } from "./text.ts";
import { reasonsOf, verdictOf } from "./verdict.ts";

/**
 * How a judge step ended: `judged` with the verdict (now, or by an earlier attempt), `failed` when the
 * model could not answer (its candidate dropped), `skipped` for a company with no site file or one
 * already decided, `gone` for a source gone.
 */
export type JudgeStep =
  | { readonly status: "judged"; readonly verdict: Verdict }
  | { readonly status: "failed" | "skipped" | "gone" };

/** What the step reads before the call, in the caller's run of the workspace. */
type Read = {
  readonly input: ResearchJudgeInput;
  readonly pages: readonly SitePageFacts[];
  readonly criteria: {
    readonly mustHaves: readonly string[];
    readonly disqualifiers: readonly string[];
  };
  readonly audienceCountries: readonly string[];
};

/**
 * The company of the run's `index`th place in the judge queue (signals_research_judge). The decision
 * record's subject is the source. An llm_* code throws, for the activity's attempts.
 */
export async function judgeCompany(
  ref: RunRef,
  index: number,
  tenant: TenantRun,
  now = new Date(),
): Promise<JudgeStep> {
  const { workspaceId, runId, sourceId } = ref;
  const site = (await readJsonFile(workspaceId, siteKey(runId, index))) as SiteFile | null;
  if (site === null) return { status: "skipped" };
  // The company's credit (gamma-wr-051) is committed with the verdict, in the run that keeps the company,
  // and released on any other end.
  const keep = (verdicted: Verdicted) =>
    tenant(async () => {
      const kept = await keepFoundCompany(ref, site.candidateId, verdicted);
      if (site.usageId !== undefined)
        await settleCompanyCredit(site.usageId, kept.status === "judged");
      return kept;
    });
  const release = () =>
    site.usageId === undefined
      ? Promise.resolve()
      : tenant(() => settleCompanyCredit(site.usageId ?? "", false));
  const filed = (await readJsonFile(workspaceId, verdictKey(runId, index))) as Verdicted | null;
  if (filed !== null) return keep(filed);
  const read = await tenant(() => readInput(ref, site));
  if (read === "gone" || read === "skipped") {
    await release();
    return { status: read };
  }
  const client = givenClient();
  const call = { workspaceId, subjectRef: sourceId, input: read.input };
  const result = await callAgent(
    registeredTask(),
    call,
    client === undefined ? {} : { client },
  ).catch((error: unknown) => {
    if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
    throw error;
  });
  if (result === null || result.status !== "ok") {
    await tenant(async () => {
      await tenantClient.signalResearchCandidate.updateMany({
        where: { id: site.candidateId, state: "pending" },
        data: { state: "dropped", dropCode: JUDGE_FAILED, stateAt: now },
      });
      await addCounts(runId, { [COUNT_JUDGES_FAILED]: 1 });
      if (site.usageId !== undefined) await settleCompanyCredit(site.usageId, false);
    });
    return { status: "failed" };
  }
  const { criteria, audienceCountries, pages } = read;
  const gated = gateJudgment(result.output, pages, {
    mustHaves: criteria.mustHaves.length,
    disqualifiers: criteria.disqualifiers.length,
  });
  const verdict = verdictOf({
    focus: gated.focus.answer,
    mustHaves: gated.mustHaves.map(({ answer }) => answer),
    disqualifiers: gated.disqualifiers.map(({ answer }) => answer),
    country: gated.country?.code ?? null,
    audienceCountries,
  });
  const reasons = reasonsOf(gated, { ...criteria, pages, audienceCountries, readAt: now });
  const verdicted: Verdicted = {
    ...{ verdict, reasons, refused: gated.refused, readAt: now.toISOString() },
    ...{ onePerson: gated.onePerson, country: gated.country?.code ?? null },
    ...{ town: gated.town, state: gated.state, email: gated.email?.address ?? null },
    ...{ phones: gated.phones.map(({ number }) => number), postal: gated.postal?.address ?? null },
  };
  await writeRunFile(workspaceId, verdictKey(runId, index), verdicted);
  return keep(verdicted);
}

/**
 * The model's input and what the gates read, or `skipped` for a candidate not pending any more (an earlier
 * attempt kept it), or `gone` for a source gone. Free text of the member and the page that named the
 * company goes through the rating's scrub (links, emails and phone numbers become placeholders); the
 * company's own pages do not, since the judge reads the address, phones and postal address they print.
 */
async function readInput(ref: RunRef, site: SiteFile): Promise<Read | "gone" | "skipped"> {
  const { workspaceId, sourceId, playbookId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return "gone";
  const candidate = await tenantClient.signalResearchCandidate.findFirst({
    where: { id: site.candidateId },
  });
  if (candidate === null || candidate.state !== "pending") return "skipped";
  const config = source.config as WebResearchConfig;
  const { icp } = await audienceOf(workspaceId, playbookId);
  const list = (values: readonly string[]) =>
    values.slice(0, INPUT_ITEMS_MAX).map((value) => clean(value, INPUT_ITEM_MAX));
  const mustHaves = criteriaOf(icp.mustHaves);
  const disqualifiers = criteriaOf(icp.disqualifiers);
  const pages = pagesOf(site);
  const named =
    candidate.line === null || candidate.quote === null
      ? null
      : {
          line: clean(candidate.line, REASON_LINE_CHARS),
          quote: clean(candidate.quote, REASON_QUOTE_CHARS),
        };
  const input: ResearchJudgeInput = {
    company: { name: clean(candidate.name, 300) },
    source: {
      focus: clean(config.focus, INPUT_TEXT_MAX),
      region: clean(config.region ?? "", INPUT_TEXT_MAX),
    },
    audience: {
      mustHaves,
      disqualifiers,
      industries: list(icp.industries),
      sizeRanges: list(icp.sizeRanges),
      countries: list(icp.countries),
    },
    named,
    site: { pages: pages.map(({ address, title, text }) => ({ address, title, text })) },
  };
  return {
    input,
    pages,
    criteria: { mustHaves, disqualifiers },
    audienceCountries: icp.countries.map((code) => code.toUpperCase()),
  };
}

const BULLET = /^(?:[-*•·]+|\d{1,2}[.)])\s+/u;

/**
 * The statements of an audience's free text: one for each line or each `;`, a bullet or number at its
 * start dropped, scrubbed and cut, at most CRITERIA_MAX. A text of one sentence is one statement.
 */
export function criteriaOf(text: string): string[] {
  return text
    .split(/[\r\n;]+/u)
    .map((part) => clean(part.trim().replace(BULLET, ""), CRITERION_CHARS).trim())
    .filter((part) => part !== "")
    .slice(0, CRITERIA_MAX);
}

/**
 * The site's pages as the model and the gates read them: at most SITE_PAGES_MAX, each title and text cut,
 * all of them within SITE_TEXT_TOTAL_CHARS (the first pages first); the address without its query.
 */
function pagesOf(site: SiteFile): SitePageFacts[] {
  let room = SITE_TEXT_TOTAL_CHARS;
  const pages: SitePageFacts[] = [];
  for (const page of site.pages.slice(0, SITE_PAGES_MAX)) {
    if (room <= 0) break;
    const text = fit(page.text, Math.min(SITE_PAGE_TEXT_CHARS, room));
    room -= [...text].length;
    pages.push({
      address: addressOf(page.url),
      title: fit(page.title, SITE_PAGE_TITLE_CHARS),
      text,
      mailto: page.mailto,
    });
  }
  return pages;
}

/** A page's address without its query and fragment: a query may hold an id or a person's address. */
function addressOf(address: string): string {
  const url = URL.parse(address);
  return url === null ? "" : fit(`${url.origin}${url.pathname}`, 600);
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof researchJudgeCompanyTask {
  const task = registeredAgentTasks().get(RESEARCH_JUDGE_COMPANY);
  if (task === undefined) throw new AppError(errors.signal_research_judge_agent_not_loaded);
  return task as unknown as typeof researchJudgeCompanyTask;
}

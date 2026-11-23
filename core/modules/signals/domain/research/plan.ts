// A research run's plan (README.md "Web research"; docs/flows.md; gamma-wr-040), the run's step after its
// start: what the member gave in the app, Company Knowledge, the run's audience and the source's own
// fields, read in a tenant run; the agent signals.research-plan asked outside any run, between two
// runs; its answer gated (checks.ts), which refuses a part and keeps the rest; the plan and its queries
// written in another run. The plan's memory is what the source asked before: the queries asked within
// SIGNALS_RESEARCH_RECHECK_DAYS are told to the model and refused by the gate. The words are never
// stored in advance: each run writes its own from the member's inputs. Nothing of a query, a word or
// a text goes to a log, a span, a metric or the workflow's history: the step answers counts.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import { readCompanyKnowledge } from "@whytide/onboarding";
import { AppError, isAppError, newId } from "@whytide/platform";
import { webSearch } from "@whytide/providers";
import type { researchPlanTask } from "../../agents/research-plan/task.ts";
import { errors } from "../../errors.ts";
import { ids } from "../../ids.ts";
import { RESEARCH_PLAN, type ResearchPlanInput } from "../../schemas/research-plan.ts";
import { settings } from "../../settings.ts";
import { LANGUAGES } from "../../sources/web_research/constants.ts";
import type { WebResearchConfig } from "../../sources/web_research/index.ts";
import { audienceOf } from "../agents.ts";
import { givenClient } from "../client.ts";
import { RESEARCH_PLAN_FAILED } from "../constants.ts";
import { scrub } from "../rate/scrub.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { DAY_MS } from "../schedule/constants.ts";
import { type GatedPlan, gatePlan, type PlanBounds, queryKey } from "./checks.ts";
import {
  ASKED_IN_INPUT_MAX,
  COUNT_QUERIES_PLANNED,
  COUNT_QUERIES_REFUSED,
  INPUT_ITEM_MAX,
  INPUT_ITEMS_MAX,
  INPUT_TEXT_MAX,
  NOT_FIT_DOMAIN_CHARS,
  NOT_FIT_NAME_CHARS,
  PLACE_WORD_CHARS,
} from "./constants.ts";
import { foundStats } from "./found-stats.ts";
import { notFitOf } from "./not-fit.ts";
import { listPlaces } from "./places/registry.ts";
import { fit } from "./text.ts";

/** How a plan step ended: planned, with its counts; failed, with the run's code; or the source gone. */
export type Planned =
  | { readonly status: "planned"; readonly queries: number; readonly refused: number }
  | { readonly status: "failed"; readonly code: string }
  | { readonly status: "gone" };

/** What the step read: the model's input, and the bounds the gates hold its answer to. */
type Read = { readonly input: ResearchPlanInput; readonly bounds: PlanBounds };

const searchQuery = webSearch.shape.query;

/**
 * The plan step of a research run (signals_research_plan): a plan the run has already (a retry of the
 * step) is answered as it is, with no second call; else the plan written and its queries kept, in the
 * order of the plan. A failed call, its schema or its gate failing twice or over its budget, is
 * `failed`, `research_plan_failed`, and nothing is kept; an llm_* code throws for the activity's
 * attempts. The decision record's subject is the source.
 */
export async function planResearchRun(
  ref: RunRef,
  tenant: TenantRun,
  now = new Date(),
): Promise<Planned> {
  const task = registeredTask();
  const read = await tenant(() => readInput(ref, now));
  if (read === null) return { status: "gone" };
  if ("planned" in read) return { status: "planned", ...read.planned };
  const client = givenClient();
  const { workspaceId, sourceId } = ref;
  const call = { workspaceId, subjectRef: sourceId, input: read.input };
  const result = await callAgent(task, call, client === undefined ? {} : { client }).catch(
    (error: unknown) => {
      if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
      throw error;
    },
  );
  if (result === null || result.status !== "ok") {
    return { status: "failed", code: RESEARCH_PLAN_FAILED };
  }
  const gated = gatePlan(result.output, read.bounds);
  return tenant(() => write(ref, gated, result.decisionRecordId));
}

/**
 * The input and the bounds, or the plan the run already has (counts only), or null for a source gone.
 * Free text goes through the rating's scrub (links, emails and phone numbers become placeholders):
 * the member's words are untrusted data, and hold no person.
 */
async function readInput(ref: RunRef, now: Date): Promise<Read | { planned: Counts } | null> {
  const { workspaceId, sourceId, runId, playbookId } = ref;
  const source = await tenantClient.signalSource.findFirst({ where: { id: sourceId } });
  if (source === null) return null;
  const existing = await tenantClient.signalResearchPlan.findFirst({ where: { runId } });
  if (existing !== null) {
    const queries = await tenantClient.signalResearchQuery.count({
      where: { planId: existing.id },
    });
    const refused = Object.values(existing.refused as Record<string, number>);
    return { planned: { queries, refused: refused.reduce((sum, count) => sum + count, 0) } };
  }
  const config = source.config as WebResearchConfig;
  const { icp } = await audienceOf(workspaceId, playbookId);
  const knowledge = await readCompanyKnowledge(workspaceId);
  const since = new Date(now.getTime() - settings.SIGNALS_RESEARCH_RECHECK_DAYS * DAY_MS);
  const askedRows = await tenantClient.signalResearchQuery.findMany({
    where: { sourceId, askedAt: { gte: since } },
    select: { id: true, placeId: true, country: true, language: true, text: true },
    orderBy: [{ askedAt: "desc" }, { id: "desc" }],
  });
  const stats = await foundStats(sourceId);
  const notFit = await notFitOf(sourceId);
  const places = listPlaces();
  const languages = config.languages ?? [];
  const text = (value: string) => fit(scrub(value, "") ?? "", INPUT_TEXT_MAX);
  const list = (values: readonly string[]) =>
    values.slice(0, INPUT_ITEMS_MAX).map((value) => fit(scrub(value, "") ?? "", INPUT_ITEM_MAX));
  const input: ResearchPlanInput = {
    knowledge: {
      oneLiner: text(knowledge.oneLiner),
      longDescription: text(knowledge.longDescription),
      products: list(knowledge.products),
      painPoints: list(knowledge.painPoints),
      featuresBenefits: list(knowledge.featuresBenefits),
      competitors: list(knowledge.competitors),
    },
    audience: {
      industries: list(icp.industries),
      sizeRanges: list(icp.sizeRanges),
      countries: [...icp.countries],
      titles: list(icp.titles),
      seniorities: list(icp.seniorities),
      mustHaves: text(icp.mustHaves),
      disqualifiers: text(icp.disqualifiers),
    },
    source: {
      focus: text(config.focus),
      region: text(config.region ?? ""),
      languages: [...languages],
    },
    places: places.map(({ id, shows, finding, pageKind }) => ({ id, shows, finding, pageKind })),
    asked: askedRows.slice(0, ASKED_IN_INPUT_MAX).map(({ id, placeId, ...rest }) => ({
      ...{ place: placeId, ...rest },
      found: stats.byQuery.get(id) ?? { fit: 0, notFit: 0, unsure: 0 },
    })),
    found: {
      places: [...stats.byPlace]
        .sort(([one], [two]) => one.localeCompare(two))
        .map(([place, counts]) => ({ place, ...counts })),
      towns: stats.towns.map(({ country, town, state, companies }) => ({
        ...{ country, town: fit(scrub(town, "") ?? "", PLACE_WORD_CHARS), companies },
        state: state === null ? null : fit(scrub(state, "") ?? "", PLACE_WORD_CHARS),
      })),
    },
    // The companies a member marked Not a fit for this source, as the page's text: scrubbed like every free text.
    not_fit: notFit.map(({ name, domain, country, town }) => ({
      ...{ name: fit(scrub(name, "") ?? "", NOT_FIT_NAME_CHARS), country },
      domain: fit(domain, NOT_FIT_DOMAIN_CHARS),
      town: town === null ? null : fit(scrub(town, "") ?? "", PLACE_WORD_CHARS),
    })),
  };
  const bounds: PlanBounds = {
    places: new Set(places.map(({ id }) => id)),
    countries: new Set(icp.countries.map((code) => code.toUpperCase())),
    languages: new Set(languages),
    kindLanguages: new Set(LANGUAGES),
    asked: new Set(
      askedRows.map(({ country, language, text }) => queryKey(country, language, text)),
    ),
    fits: (value) => searchQuery.safeParse(value).success,
  };
  return { input, bounds };
}

type Counts = { readonly queries: number; readonly refused: number };

/** The plan, its queries in order and the counts written, in the run; a retry finds them as they are. */
async function write(
  { workspaceId, sourceId, runId }: RunRef,
  gated: GatedPlan,
  decisionRecordId: string,
): Promise<Planned> {
  const planId = newId(ids.signal_research_plan);
  const refused = Object.values(gated.refused).reduce((sum, count) => sum + count, 0);
  const made = await tenantClient.signalResearchPlan.createMany({
    data: [
      {
        ...{ id: planId, workspaceId, sourceId, runId, decisionRecordId },
        ...{
          words: gated.words as unknown as object,
          roleWords: gated.roleWords as unknown as object,
          placeIds: [...gated.placeIds],
        },
        refused: gated.refused,
      },
    ],
    skipDuplicates: true,
  });
  if (made.count === 0) return { status: "planned", queries: gated.queries.length, refused };
  await tenantClient.signalResearchQuery.createMany({
    data: gated.queries.map(({ placeId, country, language, text }, at) => ({
      ...{ id: newId(ids.signal_research_query), workspaceId, planId, sourceId },
      ...{ position: at + 1, placeId, country, language, text },
    })),
  });
  await addCounts(runId, {
    [COUNT_QUERIES_PLANNED]: gated.queries.length,
    [COUNT_QUERIES_REFUSED]: refused,
  });
  return { status: "planned", queries: gated.queries.length, refused };
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof researchPlanTask {
  const task = registeredAgentTasks().get(RESEARCH_PLAN);
  if (task === undefined) throw new AppError(errors.signal_research_agent_not_loaded);
  return task as unknown as typeof researchPlanTask;
}

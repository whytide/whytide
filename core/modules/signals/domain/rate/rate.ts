// The rating of a source's events (README.md "Rating"; docs/flows.md; gamma-p5-030), steps of the
// run: its oldest unrated events with the person's words or a post, picked in a tenant run; a batch
// read in one, rated by the agent signals.rate-engagement outside any run, its answer written in
// another with qualification's re-score request; then the counts. The words go from the database to
// the model inside the activity, never through the workflow's history.
import { callAgent, registeredAgentTasks } from "@whytide/ai";
import { tenantClient } from "@whytide/db";
import { readCompanyKnowledge } from "@whytide/onboarding";
import { AppError, isAppError } from "@whytide/platform";
import { requestRescore } from "@whytide/qualification";
import type { rateEngagementTask } from "../../agents/rate-engagement/task.ts";
import { errors } from "../../errors.ts";
import {
  RATE_ENGAGEMENT,
  type RateEngagementInput,
  type RateEngagementOutput,
} from "../../schemas/rate-engagement.ts";
import { settings } from "../../settings.ts";
import { givenClient } from "../client.ts";
import type { TenantRun } from "../reduce/reduce.ts";
import { addCounts, type RunRef } from "../runs.ts";
import { scrub } from "./scrub.ts";

/** A batch as the model reads it, and the event and person each index names. */
type Batch = {
  readonly input: RateEngagementInput;
  readonly named: ReadonlyMap<number, { readonly eventId: string; readonly personId: string }>;
};

/**
 * The source's oldest unrated events whose evidence, not reduced, holds the person's words or a
 * post's excerpt, at most SIGNALS_RATE_MAX_EVENTS_PER_RUN (settings.ts), in the caller's tenant run:
 * their ids; none while Company Knowledge's offer is empty, as nothing can be rated against it. One
 * query, as the tenant guard refuses a relation; it names the workspace itself. The LIMIT is the
 * only bound of the ids signals_count_ratings later reads.
 */
export async function selectRatings({ workspaceId, sourceId }: RunRef): Promise<string[]> {
  if ((await offerOf(workspaceId)) === null) return [];
  const rows = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT e.id FROM signal_events e
    JOIN evidence v ON v.workspace_id = e.workspace_id AND v.event_id = e.id
    WHERE e.workspace_id = ${workspaceId} AND e.source_id = ${sourceId}
      AND e.rating_status = 'unrated' AND e.found_company_id IS NULL AND v.reduced_at IS NULL
      AND (v.excerpt IS NOT NULL OR v.post_excerpt IS NOT NULL)
    ORDER BY e.occurred_at, e.id
    LIMIT ${settings.SIGNALS_RATE_MAX_EVENTS_PER_RUN}`;
  return rows.map(({ id }) => id);
}

/**
 * The batch rated (signals_rate_events): read in one tenant run, the agent asked outside any, the
 * answer written in another; how many it rated. ai_failed leaves the batch unrated, as an empty
 * offer and a batch over the agent's budget do (its words, not the next batch's); an llm_* code
 * throws, for the activity's attempts.
 */
export async function rateEvents(
  { workspaceId, sourceId }: RunRef,
  eventIds: readonly string[],
  tenant: TenantRun,
): Promise<{ rated: number }> {
  const task = registeredTask();
  const batch = await tenant(() => readBatch(workspaceId, eventIds));
  if (batch === null) return { rated: 0 };
  const client = givenClient();
  const call = { workspaceId, subjectRef: sourceId, input: batch.input };
  const result = await callAgent(task, call, client === undefined ? {} : { client }).catch(
    (error: unknown) => {
      if (isAppError(error) && error.code === "ai_budget_exceeded") return null;
      throw error;
    },
  );
  if (result === null || result.status === "ai_failed") return { rated: 0 };
  return { rated: await tenant(() => writeRatings(batch, result.output, result.decisionRecordId)) };
}

/** The run's counts gain `rated`, the events picked now rated, and `unrated`, the rest of them. */
export async function countRatings(runId: string, eventIds: readonly string[]): Promise<void> {
  const where = { id: { in: [...eventIds] }, ratingStatus: "rated" };
  const rated = await tenantClient.signalEvent.count({ where });
  await addCounts(runId, { rated, unrated: eventIds.length - rated });
}

/** An event as a batch reads it: its ids and kind, and its evidence's texts, reaction and author. */
export type RatedEvent = {
  readonly id: string;
  readonly personId: string;
  readonly kind: string;
  readonly excerpt: string | null;
  readonly postExcerpt: string | null;
  /** Null for a research event (gamma-wr-060), which holds no excerpt either and is never rated. */
  readonly reaction: string | null;
  readonly author: string | null;
};

/**
 * The batch of the events with the person's words or a post, indexed from 1: each its kind, its role
 * (a like and a repost are reactions), its words and its post scrubbed; null when none has either.
 */
export function batchOf(offer: RateEngagementInput["offer"], events: readonly RatedEvent[]) {
  const kept = events.filter((event) => (event.excerpt ?? event.postExcerpt) !== null);
  if (kept.length === 0) return null;
  const input = {
    offer,
    events: kept.map(({ kind, reaction, excerpt, postExcerpt, author }, n) => ({
      index: n + 1,
      kind,
      role: reaction === "author" || reaction === "comment" ? reaction : "reaction",
      words: scrub(excerpt, author ?? ""),
      post: scrub(postExcerpt, author ?? ""),
    })),
  } satisfies RateEngagementInput;
  const named = kept.map(({ id, personId }, n) => [n + 1, { eventId: id, personId }] as const);
  return { input, named: new Map(named) } satisfies Batch;
}

/**
 * The batch of the events still unrated whose evidence is not reduced, against Company Knowledge's
 * offer; null when none is left or the offer is empty, as nothing can be rated against it.
 */
async function readBatch(workspaceId: string, eventIds: readonly string[]): Promise<Batch | null> {
  const events = await tenantClient.signalEvent.findMany({
    where: { id: { in: [...eventIds] }, ratingStatus: "unrated", foundCompanyId: null },
    select: { id: true, personId: true, kind: true },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
  });
  const rows = await tenantClient.evidence.findMany({
    where: { eventId: { in: events.map(({ id }) => id) }, reducedAt: null },
    select: { eventId: true, excerpt: true, postExcerpt: true, reaction: true, author: true },
  });
  const evidence = new Map(rows.map((row) => [row.eventId, row]));
  const rated = events.flatMap((event) => {
    const row = evidence.get(event.id);
    return row === undefined ? [] : [{ ...event, ...row }];
  });
  const offer = await offerOf(workspaceId);
  return offer === null ? null : batchOf(offer, rated);
}

/** Company Knowledge's one-liner, products and pain points; null when all three are empty. */
async function offerOf(workspaceId: string): Promise<RateEngagementInput["offer"] | null> {
  const { oneLiner, products, painPoints } = await readCompanyKnowledge(workspaceId);
  if (oneLiner.trim() === "" && products.length === 0 && painPoints.length === 0) return null;
  return { oneLiner, products: [...products], painPoints: [...painPoints] };
}

/**
 * Each rating written to its event, while unrated, with the decision record; an event whose evidence
 * was reduced meanwhile keeps no rationale. The rated persons go to qualification's re-score request.
 */
async function writeRatings(
  batch: Batch,
  output: RateEngagementOutput,
  decisionRecordId: string,
): Promise<number> {
  const persons = new Set<string>();
  const rated: string[] = [];
  for (const { index, relevance, rationale, intentClass } of output.ratings) {
    const named = batch.named.get(index);
    if (named === undefined) continue;
    const data = { relevance, relevanceRationale: rationale, intentClass, decisionRecordId };
    const { count } = await tenantClient.signalEvent.updateMany({
      where: { id: named.eventId, ratingStatus: "unrated" },
      data: { ...data, ratingStatus: "rated" },
    });
    if (count === 0) continue;
    rated.push(named.eventId);
    persons.add(named.personId);
  }
  const reduced = await tenantClient.evidence.findMany({
    where: { eventId: { in: rated }, reducedAt: { not: null } },
    select: { eventId: true },
  });
  await tenantClient.signalEvent.updateMany({
    where: { id: { in: reduced.map(({ eventId }) => eventId) } },
    data: { relevanceRationale: null },
  });
  if (persons.size > 0) await requestRescore({ personIds: [...persons] });
  return rated.length;
}

/** The task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask(): typeof rateEngagementTask {
  const task = registeredAgentTasks().get(RATE_ENGAGEMENT);
  if (task === undefined) throw new AppError(errors.signal_rating_agent_not_loaded);
  return task as unknown as typeof rateEngagementTask;
}

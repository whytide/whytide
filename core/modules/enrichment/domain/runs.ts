// A run's rows (README "How it works", docs/flows.md), each function inside the caller's tenant run:
// a new run by its key, once; the prepare step, which reads the person and its company, decides what
// the run wants and why it skips the company, and answers the plan; the outcome of one source; the
// finish, which ends the run done, or failed when its own steps failed, and releases the lead's hold
// whatever happened. A run that privacy's eraser deleted under way has no row: its steps write
// nothing more and fail none. The writers of a running run's row take its lock, one at a time, so a
// source's late answer and the finish never write past each other. Ids, field names and codes only
// cross: the values stay in contacts.
import { getPerson, refreshCompany, releaseEnrichmentHold } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId } from "@whytide/platform";
import { errors } from "../errors.ts";
import { ids } from "../ids.ts";
import { settings } from "../settings.ts";
import { now } from "./clock.ts";
import {
  COMPANY_FIELDS,
  DAY_MS,
  DB_TIMEOUT_SECONDS,
  MINUTE_MS,
  PROVIDER_TIMEOUT_SECONDS,
  RECENT_RUNS,
  RUN_STALE_MINUTES,
} from "./constants.ts";
import {
  type CompanyRun,
  companySkip,
  companyWanted,
  inputsOf,
  type Plan,
  type PlanEntry,
  personWanted,
  type SourceTried,
  triedOf,
} from "./plan.ts";
import { idOf } from "./readers.ts";
import type { SourceDefinition } from "./sources/define.ts";

export type Trigger = "new_lead" | "request";
/** A run's row as the steps read it. */
export type RunRow = {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  readonly trigger: Trigger;
  readonly status: "queued" | "running" | "done" | "failed";
  readonly wanted: string[];
  readonly filled: string[];
  readonly sourcesTried: unknown;
};

/** The run of `requestKey`, written queued unless the workspace has it already: its id. */
export async function createRun(input: {
  personId: string;
  trigger: Trigger;
  requestKey: string;
}): Promise<{ runId: string; created: boolean }> {
  const { personId, trigger, requestKey } = input;
  const { workspaceId } = currentTenant();
  const id = newId(ids.enrichment_run);
  const { count } = await tenantClient.enrichmentRun.createMany({
    data: [{ id, workspaceId, personId, trigger, requestKey, createdAt: now() }],
    skipDuplicates: true,
  });
  if (count === 1) return { runId: id, created: true };
  return { runId: (await runOf({ requestKey })).id, created: false };
}

/** The batch's run of a held lead, or none when its key has one: that lead's hold is released. */
export async function openNewLeadRun(personId: string): Promise<{ runId: string | null }> {
  const run = await createRun({
    personId,
    trigger: "new_lead",
    requestKey: `new_lead:${personId}`,
  });
  if (run.created) return { runId: run.runId };
  await releaseEnrichmentHold([personId]);
  return { runId: null };
}

/**
 * The prepare step: the run `running` with what it wants and why it skips the company, under a lock
 * on the workspace's company, so that two runs never work on one company; the plan, with no value.
 * The company is refreshed first (contacts' refreshCompany, gamma-rf-010), so a fact the shared
 * company or the organization holds already is not wanted again, unless it is older than
 * ENRICHMENT_FACT_DAYS when the run starts (gamma-rf-020).
 */
export async function prepareRun(
  runId: string,
  loaded: readonly SourceDefinition[],
): Promise<Plan> {
  const run = await keptRun(runId);
  if (run === null) return { sources: [], wanted: [], have: [] };
  const person = await getPerson(run.personId);
  const company = person.companyId === null ? null : await refreshCompany(person.companyId);
  const at = now();
  const fromCompany = companyWanted(company, { at, days: settings.ENRICHMENT_FACT_DAYS });
  let recent: CompanyRun[] = [];
  let running = false;
  if (company !== null && fromCompany.length > 0) {
    const lock = `enrichment.company:${run.workspaceId}:${company.id}`;
    await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
    recent = await recentRuns(company.id, at);
    running = await otherRunning(company.id, runId, at);
  }
  const companyName = Boolean(person.companyName?.trim());
  const skipReason = companySkip({
    company: company !== null,
    companyName,
    trigger: run.trigger,
    wanted: fromCompany,
    recent,
    running,
  });
  const companySources = skipReason === null ? loaded.filter((s) => s.kind === "company") : [];
  const personSources = loaded.filter((source) => source.kind === "person");
  const wanted = [
    ...(companySources.length > 0 ? fromCompany : []),
    ...personWanted(
      person,
      personSources.flatMap((source) => source.fills),
    ),
  ];
  await tenantClient.enrichmentRun.update({
    where: { id: runId },
    data: { status: "running", startedAt: at, companyId: company?.id ?? null, skipReason, wanted },
  });
  const sources = [...companySources, ...personSources].filter((source) =>
    source.fills.some((field) => wanted.includes(field)),
  );
  const name = company !== null || companyName;
  return { sources: sources.map(entryOf), wanted, have: inputsOf(company, person, name) };
}

/**
 * One source's outcome, once per source, while the run is running: a second record of it, the
 * workflow's after a failure, is none, and so is one after the finish.
 */
export async function recordTried(
  runId: string,
  entry: SourceTried,
  companyId?: string,
): Promise<void> {
  const run = await lockedRun(runId);
  if (run === null || run.status !== "running") return;
  const tried = triedOf(run.sourcesTried);
  if (tried.some(({ source }) => source === entry.source)) return;
  await tenantClient.enrichmentRun.update({
    where: { id: runId },
    data: {
      sourcesTried: [...tried, entry],
      filled: [...new Set([...run.filled, ...entry.filled])],
      ...(companyId !== undefined && { companyId }),
    },
  });
}

/** The finish: `done`, or `failed` when the run's own steps failed; the lead's hold released. */
export async function finishRun(runId: string, failed: boolean): Promise<{ filled: string[] }> {
  const run = await lockedRun(runId);
  if (run === null) return { filled: [] };
  const status = failed ? "failed" : "done";
  await tenantClient.enrichmentRun.update({
    where: { id: runId },
    data: { status, finishedAt: now() },
  });
  await releaseEnrichmentHold([run.personId]);
  return { filled: run.filled };
}

/** The run of the workspace by its id or its key; enrichment_input_invalid naming `runId` for none. */
export async function runOf(where: { id: string } | { requestKey: string }): Promise<RunRow> {
  const run = await tenantClient.enrichmentRun.findFirst({ where });
  if (run === null) {
    throw new AppError(errors.enrichment_input_invalid, { details: { fields: ["runId"] } });
  }
  return run;
}

/** The run of the workspace by its id, or none: privacy's eraser deleted it with its person. */
export async function keptRun(runId: string): Promise<RunRow | null> {
  return tenantClient.enrichmentRun.findFirst({ where: { id: idOf("runId", runId) } });
}

/** keptRun, its writers one at a time: the run's lock, held to the transaction's end. */
export async function lockedRun(runId: string): Promise<RunRow | null> {
  const lock = `enrichment.run:${currentTenant().workspaceId}:${idOf("runId", runId)}`;
  await tenantClient.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lock}, 0))`;
  return keptRun(runId);
}

/** The company's runs that finished done within the retry days, newest first. */
async function recentRuns(companyId: string, at: Date): Promise<CompanyRun[]> {
  const since = new Date(at.getTime() - settings.ENRICHMENT_COMPANY_RETRY_DAYS * DAY_MS);
  const rows = await tenantClient.enrichmentRun.findMany({
    where: { companyId, status: "done", finishedAt: { gte: since } },
    select: { wanted: true, sourcesTried: true },
    orderBy: { finishedAt: "desc" },
    take: RECENT_RUNS,
  });
  return rows.map((row) => ({ wanted: row.wanted, tried: triedOf(row.sourcesTried) }));
}

/** Another run working on the company's fields, started within RUN_STALE_MINUTES. */
async function otherRunning(companyId: string, runId: string, at: Date): Promise<boolean> {
  const since = new Date(at.getTime() - RUN_STALE_MINUTES * MINUTE_MS);
  const other = await tenantClient.enrichmentRun.findFirst({
    where: {
      companyId,
      status: "running",
      skipReason: null,
      id: { not: runId },
      startedAt: { gte: since },
      wanted: { hasSome: [...COMPANY_FIELDS] },
    },
    select: { id: true },
  });
  return other !== null;
}

/** A source as the plan names it: kinds, names and its timeout. */
function entryOf(source: SourceDefinition): PlanEntry {
  const timeoutSeconds =
    source.timeoutSeconds ??
    (source.activityKind === "provider" ? PROVIDER_TIMEOUT_SECONDS : DB_TIMEOUT_SECONDS);
  const { name, activityKind, needs, fills } = source;
  return { source: name, activityKind, needs, fills, timeoutSeconds };
}

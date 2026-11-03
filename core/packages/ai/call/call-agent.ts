// callAgent (README.md "Calling an agent"; docs/architecture.md §8, docs/rules/security.md §6): every
// agent call of a module goes through it. The result cache first, then runAgent with the task's gates,
// retried once with the failure in a data block, then ai_failed (attempts.ts); one decision record and
// one cost event per call. A port's code (llm_*) is thrown for Temporal to retry the activity, never
// answered with a fallback output. Each call, its retries, tokens and cost are counted (metrics.ts).
import { costStore, Prisma, type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import {
  AppError,
  costConfig,
  newId,
  type PriceTable,
  platformIds,
  priceFor,
  recordCost,
  servicePrincipal,
} from "@whytide/platform";
import type { z } from "zod";
import { aiErrors } from "../errors.ts";
import { type AgentTask, registeredAgentTasks } from "../registry/define.ts";
import { agentModel, parseAgentInput } from "../run/run-agent.ts";
import { runAttempts } from "./attempts.ts";
import { callConfig } from "./config.ts";
import { inputHash } from "./hash.ts";
import { aiMetrics } from "./metrics.ts";
import { findDecision, saveDecision } from "./records.ts";

/** The retry rule, public here as before: attempts.ts holds it with the loop it drives. */
export { MAX_ATTEMPTS, nextStep } from "./attempts.ts";

export type AgentCall<I extends z.ZodObject> = {
  readonly workspaceId: string;
  /** What the call is about, a person id or another id: in the cache key and on the cost event. */
  readonly subjectRef: string;
  readonly input: z.input<I>;
};
export type CallOptions = {
  /** The `app` client of the tenant runs, a test's `asRole("app")`; withTenant's own by default. */
  readonly client?: PrismaClient;
  /** The cost event's price table: COST_PRICES_JSON by default. */
  readonly prices?: PriceTable;
};
/** `ok` with the output, or `ai_failed` with the last attempt's reason; both name their record. */
export type CallResult<O> = {
  readonly decisionRecordId: string;
  readonly attempts: number;
  /** The output is an earlier call's record: no model was asked. */
  readonly cached: boolean;
} & (
  | { readonly status: "ok"; readonly output: O }
  | { readonly status: "ai_failed"; readonly reason: string }
);

const DAY_MS = 86_400_000;
const TOKENS = { input_tokens: 0, output_tokens: 0 };
const principal = servicePrincipal("ai");

export async function callAgent<I extends z.ZodObject, O extends z.ZodObject>(
  task: AgentTask<I, O>,
  call: AgentCall<I>,
  options: CallOptions = {},
): Promise<CallResult<z.output<O>>> {
  const { workspaceId, subjectRef } = call;
  if (typeof subjectRef !== "string" || subjectRef === "") {
    const details = { task: task.name, fields: ["subjectRef"] };
    throw new AppError(aiErrors.ai_input_invalid, { details });
  }
  const hash = inputHash(parseAgentInput(task, call.input));
  const model = await agentModel(task);
  const { modelId, vendor } = model;
  const { name, promptVersion } = task;
  const key = { workspaceId, task: name, subjectRef, inputHash: hash, modelId, promptVersion };
  const tenant = { workspaceId, principal };
  const db = { client: options.client };
  const ok = (row: { id: string; output: unknown; attempts: number }, cached: boolean) => ({
    status: "ok" as const,
    output: row.output as z.output<O>,
    decisionRecordId: row.id,
    attempts: row.attempts,
    cached,
  });
  // A cached output that no longer parses against the output schema is a miss: this call replaces it.
  const found = await withTenant(tenant, (tx) => findDecision(tx, key), db);
  const hit = found ? task.outputSchema.safeParse(found.output) : undefined;
  if (found && hit?.success) {
    aiMetrics["ai.calls"].add(1, { task: name, outcome: "cached" });
    return ok({ ...found, output: hit.data }, true);
  }

  const cost = async (tx: TenantClient) => {
    const { inputTokens, outputTokens } = model.usage;
    const units = { input_tokens: inputTokens, output_tokens: outputTokens };
    const event = { workspace_id: workspaceId, feature: task.module, task: name, units };
    const priced = { ...event, vendor, model: modelId, subject_ref: subjectRef };
    const recorded = await recordCost(costStore(tx), priced, { prices: options.prices });
    aiMetrics["ai.tokens"].add(inputTokens, { task: name, kind: "input" });
    aiMetrics["ai.tokens"].add(outputTokens, { task: name, kind: "output" });
    aiMetrics["ai.cost"].add(Number(recorded.unit_cost), { task: name });
    return recorded;
  };
  const outcome = await runAttempts(task, call.input, model).catch(async (error: unknown) => {
    // No record: Temporal retries the activity. Tokens an earlier attempt reported were billed.
    if (model.usage.inputTokens + model.usage.outputTokens > 0) await withTenant(tenant, cost, db);
    aiMetrics["ai.calls"].add(1, { task: name, outcome: "error" });
    throw error;
  });
  const { run, failures, latencyMs, count } = outcome;
  const now = new Date();
  const row = await withTenant(
    tenant,
    async (tx) => {
      const { unit_cost } = await cost(tx);
      const data: Prisma.DecisionRecordUncheckedCreateInput = {
        id: newId(platformIds.decision_record),
        ...key,
        status: run.ok ? "ok" : "ai_failed",
        output: run.ok ? (run.output as Prisma.InputJsonValue) : Prisma.DbNull,
        gates: failures,
        latencyMs,
        inputTokens: model.usage.inputTokens,
        outputTokens: model.usage.outputTokens,
        costCredits: unit_cost,
        attempts: count,
        rawPrompt: run.message,
        rawOutput: run.text,
        rawPurgeAfter: new Date(now.getTime() + callConfig.AI_RAW_RETENTION_DAYS * DAY_MS),
        createdAt: now,
      };
      return saveDecision(tx, data, found?.id);
    },
    db,
  );
  aiMetrics["ai.calls"].add(1, { task: name, outcome: row.status });
  if (count > 1) aiMetrics["ai.retries"].add(count - 1, { task: name });
  if (row.status === "ok") return ok(row, false);
  const reason = run.ok ? "" : run.reason;
  return { status: "ai_failed", reason, decisionRecordId: row.id, attempts: count, cached: false };
}

/**
 * For a host's start, after loadAgentTasks(): every registered task's model is priced for its tokens
 * in the table, or `cost_price_missing` names the vendor and the model at boot, not after a paid call.
 */
export async function checkAgentPrices(
  prices: PriceTable | undefined = costConfig.COST_PRICES_JSON,
): Promise<void> {
  if (!prices) {
    const details = { variable: "COST_PRICES_JSON" };
    throw new AppError("cost_prices_not_configured", { details });
  }
  for (const task of registeredAgentTasks().values()) {
    const { vendor, modelId } = await agentModel(task);
    priceFor(prices, { vendor, model: modelId, units: TOKENS });
  }
}

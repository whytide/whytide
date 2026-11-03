// writeDraft (README.md "The writer", docs/flows.md "A draft written"): the domain function the
// draft workflow's activity calls, outside any run. The draft in a tenant run; the requester's membership
// outside one (tenancy's reads of the global tables refuse a run), and the dossier as that member,
// its sender; then the plan and the text, each checked by its gates and, on an issue, regenerated
// with the issues in its <failures> block, at most twice in all; then the draft's record in a last
// run, once. A retried activity finds the draft written, or redoes the calls, which the cache
// answers. Nothing here logs: no text, fact or name leaves in a log line, a span or an error.
import {
  type AgentTask,
  agentModel,
  type CallOptions,
  callAgent,
  registeredAgentTasks,
} from "@whytide/ai";
import { Prisma, type TenantClient } from "@whytide/db";
import { type ActivityContext, AppError, isAppError, type Principal } from "@whytide/platform";
import { resolveMembership } from "@whytide/tenancy";
import { z } from "zod";
import type { planMessageTask } from "../../agents/plan-message/task.ts";
import type { writeMessageTask } from "../../agents/write-message/task.ts";
import { errors } from "../../errors.ts";
import { type GateIssue, PLAN_MESSAGE, planOutput, WRITE_MESSAGE } from "../../schemas/writer.ts";
import { buildDossier } from "../dossier/build.ts";
import {
  checkPlan,
  checkText,
  factIdsOf,
  type GateResult,
  issuesOf,
  limitsOf,
} from "../gates/index.ts";
import { writerBlocks } from "./blocks.ts";
import { parse } from "./store.ts";

/** Where writeDraft runs: the activity's workspace and runs; callAgent's options in a test. */
export type DraftContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant"> & {
  readonly call?: CallOptions;
};
export type DraftStatus = "drafting" | "ready" | "flagged" | "failed" | "edited";
/** Why a draft failed, as its flag_reasons keeps it: a code, never a text. */
export type FailureCode =
  | "ai_failed"
  | "draft_requester_not_member"
  | "dossier_lead_not_found"
  | "write_failed";

/** A draft's regenerations, its plan's and its text's together (docs/security.md "The gates"). */
export const MAX_REGENERATIONS = 2;
const ai = [{ code: "ai_failed" }] as const;

const id = z.string().min(1).max(64);
const writeDraftInput = z.object({ draftId: id, userId: id, replacesId: id.optional() });
/** The plan as the draft keeps it: the planner's answer and its call's decision record. */
const storedPlan = planOutput.extend({ decisionRecordId: z.string() });
type StoredPlan = z.output<typeof storedPlan>;
type Call = {
  readonly decisionRecordId: string;
  readonly modelId: string;
  readonly promptVersion: number;
};
/** What the draft's last run writes. */
type Written = {
  readonly status: "ready" | "flagged" | "failed";
  readonly plan?: StoredPlan;
  readonly text?: string;
  /** The last call's: the write's, or else the plan's. */
  readonly call?: Call;
  readonly dossierHash?: string;
  readonly gates?: readonly GateResult[];
  readonly regenerations?: number;
  readonly flagReasons: readonly (GateIssue | { readonly code: FailureCode })[];
};

/**
 * Writes the `drafting` draft for the member `userId`, a regeneration of `replacesId` when given,
 * and answers its status; a draft written already answers its own. draft_not_found,
 * writer_agent_not_loaded; ai's and the LLM port's codes are thrown, for Temporal to retry.
 */
export async function writeDraft(
  input: z.input<typeof writeDraftInput>,
  context: DraftContext,
): Promise<{ status: DraftStatus }> {
  const { draftId, userId, replacesId } = parse(writeDraftInput, input);
  const plan = registeredTask<typeof planMessageTask>(PLAN_MESSAGE);
  const write = registeredTask<typeof writeMessageTask>(WRITE_MESSAGE);
  const draft = await context.tenant((tx) => tx.messageDraft.findFirst({ where: { id: draftId } }));
  if (draft === null) throw new AppError(errors.draft_not_found);
  if (draft.status !== "drafting") return { status: draft.status };
  const { workspaceId } = context;
  const failed = (code: FailureCode) =>
    store(context, draftId, { status: "failed", flagReasons: [{ code }] });

  const membership = await resolveMembership({ userId, workspaceIdOrSlug: workspaceId });
  if (membership === null) return failed("draft_requester_not_member");
  const principal: Principal = {
    userId,
    actorType: "human",
    authMethod: "session",
    membershipId: membership.id,
    workspaceId,
    role: membership.role,
    scopes: [],
  };
  const tenant = { workspaceId, principal };
  const dossier = await buildDossier(tenant, draft.personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === errors.dossier_lead_not_found) return null;
    throw error;
  });
  if (dossier === null) return failed("dossier_lead_not_found");

  const replaced =
    replacesId === undefined ? null : await readReplaced(context, replacesId, draft.personId);
  const limits = limitsOf(draft.channel);
  const blocks = writerBlocks(dossier);
  const known = factIdsOf(blocks);
  const channel = { channel: draft.channel, minCharacters: limits.min, maxCharacters: limits.max };
  const shared = { channel, ...blocks, replaced };
  const ask = { workspaceId, subjectRef: draft.personId };
  const models = { plan: await modelOf(plan), write: await modelOf(write) };
  const { dossierHash } = dossier;
  let regenerations = 0;
  const end = (written: Omit<Written, "dossierHash" | "regenerations">) =>
    store(context, draftId, { ...written, dossierHash, regenerations });

  const planFailures: GateIssue[][] = [];
  const textFailures: GateIssue[][] = [];
  let planned: StoredPlan | undefined;
  let planGates: GateResult[] = [];
  for (;;) {
    if (planned === undefined) {
      const input = { ...shared, failures: planFailures };
      const result = await callAgent(plan, { ...ask, input }, context.call);
      const call = { decisionRecordId: result.decisionRecordId, ...models.plan };
      if (result.status === "ai_failed") return end({ status: "failed", call, flagReasons: ai });
      const answer = { ...result.output, decisionRecordId: result.decisionRecordId };
      planGates = checkPlan(result.output, known);
      const issues = issuesOf(planGates);
      if (issues.length > 0) {
        const gates = planGates;
        if (regenerations === MAX_REGENERATIONS) {
          return end({ status: "flagged", plan: answer, call, gates, flagReasons: issues });
        }
        regenerations += 1;
        planFailures.push(issues);
        continue;
      }
      planned = answer;
    }
    const { angle, factIds, cta } = planned;
    const input = { ...shared, plan: { angle, factIds, cta }, failures: textFailures };
    const result = await callAgent(write, { ...ask, input }, context.call);
    const call = { decisionRecordId: result.decisionRecordId, ...models.write };
    if (result.status === "ai_failed") {
      return end({ status: "failed", plan: planned, call, flagReasons: ai });
    }
    const text = result.output.text.trim();
    const gates = [...planGates, ...checkText(text, dossier, limits)];
    const issues = issuesOf(gates);
    const done = { plan: planned, text, call, gates };
    if (issues.length === 0) return end({ ...done, status: "ready", flagReasons: [] });
    if (regenerations === MAX_REGENERATIONS) {
      return end({ ...done, status: "flagged", flagReasons: issues });
    }
    regenerations += 1;
    textFailures.push(issues);
  }
}

/** Writes the draft's record if it is `drafting` still, and answers its status as stored. */
async function store(
  context: DraftContext,
  draftId: string,
  written: Written,
): Promise<{ status: DraftStatus }> {
  const { status, plan, text, call, dossierHash, gates = [], regenerations = 0 } = written;
  const data = {
    status,
    plan: plan ?? Prisma.DbNull,
    text: text ?? null,
    modelId: call?.modelId ?? null,
    promptVersion: call?.promptVersion ?? null,
    decisionRecordId: call?.decisionRecordId ?? null,
    dossierHash: dossierHash ?? null,
    gates: gates as Prisma.InputJsonArray,
    regenerations,
    flagReasons: written.flagReasons as Prisma.InputJsonArray,
  };
  return context.tenant(async (tx) => {
    const where = { id: draftId, status: "drafting" as const };
    const { count } = await tx.messageDraft.updateMany({ where, data });
    if (count === 1) return { status };
    // Another attempt of the activity wrote it first.
    const select = { status: true } as const;
    const stored = await tx.messageDraft.findFirst({ where: { id: draftId }, select });
    if (stored === null) throw new AppError(errors.draft_not_found);
    return stored;
  });
}

/** The draft a regeneration replaces, as the member last saw it: null where it had no value. */
async function readReplaced(context: DraftContext, replacesId: string, personId: string) {
  const select = { plan: true, text: true, editedText: true } as const;
  const where = { id: replacesId, personId };
  const row = await context.tenant((tx) => tx.messageDraft.findFirst({ where, select }));
  const plan = storedPlan.safeParse(row?.plan);
  const text = row?.editedText ?? row?.text ?? null;
  return plan.success
    ? { angle: plan.data.angle, cta: plan.data.cta, text }
    : { angle: null, cta: null, text };
}

/** A task the host registered at start (loadAgentTasks); never imported here (agents/). */
function registeredTask<T>(name: string): T {
  const task = registeredAgentTasks().get(name);
  if (task === undefined) throw new AppError(errors.writer_agent_not_loaded);
  return task as unknown as T;
}

/** The model and the prompt version a task's calls record, as the draft keeps them. */
async function modelOf(task: AgentTask) {
  return { modelId: (await agentModel(task)).modelId, promptVersion: task.promptVersion };
}

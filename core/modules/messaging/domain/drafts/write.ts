// writeDraft (README.md "The writer", docs/flows.md "A draft written"): the domain function the
// draft workflow's activity calls, outside any run. The draft in a tenant run; the requester's membership
// outside one (tenancy's reads of the global tables refuse a run), and the dossier as that member,
// its sender; then the plan and the text, each checked by its gates and, on an issue, regenerated
// with the issues in its <failures> block, at most twice in all; then the draft's record in a last
// run, once. A retried activity finds the draft written, or redoes the calls, which the cache
// answers. Nothing here logs: no text, fact or name leaves in a log line, a span or an error.
// A sequence step's draft (beta-p3-010) also reads the same person's earlier approved drafts, by
// id, and sends their texts in the <step> block of both calls; its last run publishes
// messaging.step_draft_ready. That run writes only a draft still `drafting`: one the sweep failed
// meanwhile stays failed, and the late answer is dropped. The person's colleagues' names, read once
// in a run of their own after the dossier, feed the colleague-signal gate (beta-p3-020). An email
// draft (gamma-p3-070) is written by the email writer, a subject and a body, against the email
// gates, a step's against its mailbox's other drafts of the last day, read with the draft; and every
// draft is held back, with no model call, when the lead's profile is in another language.
import {
  type AgentTask,
  agentModel,
  type CallOptions,
  callAgent,
  registeredAgentTasks,
} from "@whytide/ai";
import { colleaguesOf, errors as contactsErrors } from "@whytide/contacts";
import { outboxWriter, Prisma, type TenantClient } from "@whytide/db";
import { type ActivityContext, AppError, isAppError, type Principal } from "@whytide/platform";
import { resolveMembership } from "@whytide/tenancy";
import { z } from "zod";
import type { planMessageTask } from "../../agents/plan-message/task.ts";
import type { writeEmailTask } from "../../agents/write-email/task.ts";
import type { writeMessageTask } from "../../agents/write-message/task.ts";
import { errors } from "../../errors.ts";
import {
  type Channel,
  type EmailChannelBlock,
  type GateIssue,
  type LinkedinChannelBlock,
  PLAN_MESSAGE,
  planOutput,
  type StepBlock,
  WRITE_EMAIL,
  WRITE_MESSAGE,
  type writeInput,
} from "../../schemas/writer.ts";
import { buildDossier } from "../dossier/build.ts";
import { mailboxBodies } from "../gates/check-text.ts";
import { EMAIL_SUBJECT_MAX_CHARACTERS, EMAIL_SUBJECT_MAX_WORDS } from "../gates/constants.ts";
import {
  type Colleague,
  checkPlan,
  checkWrittenText,
  factIdsOf,
  type GateResult,
  issuesOf,
  limitsOf,
} from "../gates/index.ts";
import { type EarlierDraft, stepBlock, writerBlocks } from "./blocks.ts";
import {
  EARLIER_DRAFTS_MAX,
  STEP_KEYS,
  type StepDraftEnd,
  type WrittenStepKind,
} from "./constants.ts";
import { kindFits, writtenKindOf } from "./kinds.ts";
import { profileLanguage } from "./language.ts";
import { parse, publishStepDraftEnds } from "./store.ts";

/** Where writeDraft runs: the activity's workspace and runs; callAgent's options in a test. */
export type DraftContext = Pick<ActivityContext<TenantClient>, "workspaceId" | "tenant"> & {
  readonly call?: CallOptions;
};
export type DraftStatus = "drafting" | "ready" | "flagged" | "failed" | "edited" | "approved";
/** Why a draft failed, as its flag_reasons keeps it: a code, never a text. */
export type FailureCode =
  | "ai_failed"
  | "draft_requester_not_member"
  | "dossier_lead_not_found"
  | "write_failed"
  | "earlier_draft_invalid"
  | "draft_stuck"
  | "profile_not_english";

/** A draft's regenerations, its plan's and its text's together (docs/security.md "The gates"). */
export const MAX_REGENERATIONS = 2;
const ai = [{ code: "ai_failed" }] as const;

const id = z.string().min(1).max(64);
const writeDraftInput = z.object({
  draftId: id,
  userId: id,
  replacesId: id.optional(),
  earlierDraftIds: z.array(id).max(EARLIER_DRAFTS_MAX).optional(),
});
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
  readonly status: StepDraftEnd;
  readonly plan?: StoredPlan;
  readonly text?: string;
  /** An email's subject as its writer answered it; null for none. */
  readonly subject?: string | null;
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
  const { draftId, userId, replacesId, earlierDraftIds = [] } = parse(writeDraftInput, input);
  const plan = registeredTask<typeof planMessageTask>(PLAN_MESSAGE);
  const { draft, earlier, others } = await context.tenant(async (tx) => {
    const draft = await tx.messageDraft.findFirst({ where: { id: draftId } });
    const drafting = draft?.status === "drafting";
    const step = drafting && draft.kind === "outbound_step";
    const mailbox = drafting ? draft.mailboxId : null;
    return {
      draft,
      earlier: step ? await readEarlier(tx, draft.personId, earlierDraftIds) : [],
      // Other persons' texts, for the near-duplicate gate in code only: never in a prompt or a log.
      others: mailbox === null ? undefined : await mailboxBodies(tx, mailbox, draftId),
    };
  });
  if (draft === null) throw new AppError(errors.draft_not_found);
  if (draft.status !== "drafting") return { status: draft.status };
  const { workspaceId } = context;
  const failed = (code: FailureCode) =>
    store(context, draftId, { status: "failed", flagReasons: [{ code }] });
  if (earlier === null) return failed("earlier_draft_invalid");

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
  if (profileLanguage(dossier) === "other") return failed("profile_not_english");
  const colleagues = await readColleagues(context, draft.personId);
  if (colleagues === null) return failed("dossier_lead_not_found");

  const replaced =
    replacesId === undefined ? null : await readReplaced(context, replacesId, draft.personId);
  const limits = limitsOf(draft.channel);
  const blocks = writerBlocks(dossier);
  const known = factIdsOf(blocks);
  const step = stepOf(draft, earlier);
  const writer = writerOf(draft.channel, step?.kind);
  const shared = { ...blocks, ...(step && { step }), replaced };
  const ask = { workspaceId, subjectRef: draft.personId };
  const models = { plan: await modelOf(plan), write: await modelOf(writer.task) };
  const email = writer.email
    ? { first: step?.kind === "email_first", ...(others && { others }) }
    : null;
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
      const input = { ...shared, channel: writer.channel, failures: planFailures };
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
    const result = await writeOnce(writer, { ...ask, input }, context.call);
    const call = { decisionRecordId: result.decisionRecordId, ...models.write };
    if (result.written === null) {
      return end({ status: "failed", plan: planned, call, flagReasons: ai });
    }
    const { text, subject } = result.written;
    const check = email ? { ...email, subject } : undefined;
    const gates = [...planGates, ...checkWrittenText(text, dossier, limits, colleagues, check)];
    const issues = issuesOf(gates);
    const done = { plan: planned, text, subject, call, gates };
    if (issues.length === 0) return end({ ...done, status: "ready", flagReasons: [] });
    if (regenerations === MAX_REGENERATIONS) {
      return end({ ...done, status: "flagged", flagReasons: issues });
    }
    regenerations += 1;
    textFailures.push(issues);
  }
}

/**
 * Writes the draft's record if it is `drafting` still, with a step's messaging.step_draft_ready
 * in the same run, and answers its status as stored.
 */
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
    subject: written.subject ?? null,
    modelId: call?.modelId ?? null,
    promptVersion: call?.promptVersion ?? null,
    decisionRecordId: call?.decisionRecordId ?? null,
    dossierHash: dossierHash ?? null,
    gates: gates as Prisma.InputJsonArray,
    regenerations,
    flagReasons: written.flagReasons as Prisma.InputJsonArray,
  };
  return context.tenant(async (tx): Promise<{ status: DraftStatus }> => {
    const where = { id: draftId, status: "drafting" as const };
    const ends = { id: true, stepExecutionId: true } as const;
    const ended = await tx.messageDraft.updateManyAndReturn({ where, data, select: ends });
    if (ended.length === 1) {
      await publishStepDraftEnds(outboxWriter(tx, context.workspaceId), ended, status);
      return { status };
    }
    // Another attempt of the activity, or the sweep, wrote it first: this answer is dropped.
    const select = { status: true } as const;
    const stored = await tx.messageDraft.findFirst({ where: { id: draftId }, select });
    if (stored === null) throw new AppError(errors.draft_not_found);
    return stored;
  });
}

const stepKeys = z.enum(STEP_KEYS);

/**
 * The drafts a step's draft builds on, oldest first; null when any id is not an `approved` step's
 * draft of the same person in this workspace. A draft the campaign's mode approved is read as the
 * writer wrote it, without the AI disclosure line its frozen text ends with (gamma-p4-090): the
 * mode approves no edited draft, so its `text` is what went out, less the line.
 */
async function readEarlier(
  tx: TenantClient,
  personId: string,
  draftIds: readonly string[],
): Promise<EarlierDraft[] | null> {
  const unique = [...new Set(draftIds)];
  if (unique.length === 0) return [];
  const where = {
    id: { in: unique },
    personId,
    kind: "outbound_step",
    status: "approved",
  } as const;
  const select = { stepKey: true, text: true, editedText: true, disclosureApplied: true } as const;
  const orderBy = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  const rows = await tx.messageDraft.findMany({ where, select, orderBy });
  if (rows.length !== unique.length) return null;
  const earlier: EarlierDraft[] = [];
  for (const { stepKey, text, editedText, disclosureApplied } of rows) {
    const key = stepKeys.safeParse(stepKey);
    if (!key.success) return null;
    earlier.push({ stepKey: key.data, text, editedText: disclosureApplied ? null : editedText });
  }
  return earlier;
}

/**
 * The <step> block of a step's draft, its kind from its stored step key; a lead's draft's from the
 * kind it was asked as, with no earlier text, none for a LinkedIn one asked without one, a first
 * email for an email (kinds.ts). A note never reaches here (requestStepDraft makes it `ready`, with
 * no writer): a note's key, no step's, or a kind off the channel, is refused.
 */
function stepOf(
  draft: Parameters<typeof writtenKindOf>[0],
  earlier: readonly EarlierDraft[],
): StepBlock | undefined {
  const kind = writtenKindOf(draft);
  const step = draft.kind === "outbound_step";
  if (kind === null && !step) return undefined;
  if (kind === null || !kindFits(kind, draft.channel)) {
    const fields = [step ? "stepKey" : "stepKind"];
    throw new AppError(errors.messaging_input_invalid, { details: { fields } });
  }
  return stepBlock(kind, step ? earlier : []);
}

/** The channel's writer and its <channel> block: a LinkedIn text's characters, an email's words. */
type Writer =
  | {
      readonly email: false;
      readonly task: typeof writeMessageTask;
      readonly channel: LinkedinChannelBlock;
    }
  | {
      readonly email: true;
      readonly task: typeof writeEmailTask;
      readonly channel: EmailChannelBlock;
    };

function writerOf(channel: Channel, kind: WrittenStepKind | undefined): Writer {
  const { min, max } = limitsOf(channel);
  if (channel !== "email") {
    const task = registeredTask<typeof writeMessageTask>(WRITE_MESSAGE);
    return { email: false, task, channel: { channel, minCharacters: min, maxCharacters: max } };
  }
  const limits = { maxWords: EMAIL_SUBJECT_MAX_WORDS, maxCharacters: EMAIL_SUBJECT_MAX_CHARACTERS };
  const subject = kind === "email_first" ? limits : null;
  const task = registeredTask<typeof writeEmailTask>(WRITE_EMAIL);
  return { email: true, task, channel: { channel, minWords: min, maxWords: max, subject } };
}

/**
 * One call of the writer, with its <channel> block: the text, an email's body, trimmed, and an
 * email's subject, trimmed, null for none; `written` null when the call failed (ai_failed).
 */
async function writeOnce(
  writer: Writer,
  request: { workspaceId: string; subjectRef: string; input: Omit<WriteInputs, "channel"> },
  options: CallOptions | undefined,
) {
  const { workspaceId, subjectRef } = request;
  const result = writer.email
    ? await callAgent(
        writer.task,
        { workspaceId, subjectRef, input: { ...request.input, channel: writer.channel } },
        options,
      )
    : await callAgent(
        writer.task,
        { workspaceId, subjectRef, input: { ...request.input, channel: writer.channel } },
        options,
      );
  const { decisionRecordId } = result;
  if (result.status === "ai_failed") return { decisionRecordId, written: null };
  const { output } = result;
  const written =
    "body" in output
      ? { text: output.body.trim(), subject: output.subject?.trim() || null }
      : { text: output.text.trim(), subject: null };
  return { decisionRecordId, written };
}
type WriteInputs = z.input<typeof writeInput>;

/**
 * The names of the person's colleagues, for the colleague-signal gate, once per draft in a run of its
 * own, as the dossier is read; null when the person is gone meanwhile.
 */
export async function readColleagues(context: DraftContext, personId: string) {
  return context
    .tenant((): Promise<Colleague[] | null> => colleaguesOf(personId))
    .catch((error: unknown) => {
      if (isAppError(error) && error.code === contactsErrors.person_not_found) return null;
      throw error;
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
export function registeredTask<T>(name: string): T {
  const task = registeredAgentTasks().get(name);
  if (task === undefined) throw new AppError(errors.writer_agent_not_loaded);
  return task as unknown as T;
}

/** The model and the prompt version a task's calls record, as the draft keeps them. */
export async function modelOf(task: AgentTask) {
  return { modelId: (await agentModel(task)).modelId, promptVersion: task.promptVersion };
}

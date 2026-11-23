// The drafts' commands and queries (README.md "Routes", docs/flows.md), in the caller's tenant run,
// on the tenant client alone: a requested draft and its event, the reads, a member's edit, a
// regeneration, the workflow's failure mark and the person's erasure; writeDraft writes the rest
// (write.ts). A draft is `drafting` only until its writer ends, and never again. The routes read
// and change a lead's drafts only: a sequence step's (step.ts) changes through approvals' path. A
// lead's draft may be asked as a kind (gamma-p3-070), an email's first or follow-up among them,
// which its regeneration keeps; a first email's edit may change its subject.
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import {
  AppError,
  currentTenant,
  isAppError,
  newId,
  type OutboxWriter,
  publish,
} from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import type { DRAFT_KINDS } from "../../schemas/drafts.ts";
import { CHANNELS, type Channel } from "../../schemas/writer.ts";
import { requirePassingText } from "../gates/check-text.ts";
import { hardLimitOf } from "../gates/index.ts";
import { APPROVAL_TEXT_MAX, type StepDraftEnd, WRITTEN_STEP_KINDS } from "./constants.ts";
import { kindFits, writtenKindOf } from "./kinds.ts";
import type { DraftStatus } from "./write.ts";

/** A draft as the routes read it (schemas/drafts.ts); the JSON columns as stored. */
export type Draft = {
  readonly id: string;
  readonly personId: string;
  readonly channel: Channel;
  readonly kind: (typeof DRAFT_KINDS)[number];
  readonly status: DraftStatus;
  readonly stepKey: string | null;
  readonly stepKind: string | null;
  readonly plan: unknown;
  readonly text: string | null;
  readonly editedText: string | null;
  readonly editedAt: Date | null;
  readonly subject: string | null;
  readonly editedSubject: string | null;
  readonly modelId: string | null;
  readonly promptVersion: number | null;
  readonly dossierHash: string | null;
  readonly gates: unknown;
  readonly regenerations: number;
  readonly flagReasons: unknown;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

const id = z.string().min(1).max(64);
/** The kind fits the channel (kinds.ts): none for a note. */
const createDraftInput = z
  .object({
    personId: id,
    channel: z.enum(CHANNELS),
    stepKind: z.enum(WRITTEN_STEP_KINDS).optional(),
  })
  .refine(({ channel, stepKind }) => stepKind === undefined || kindFits(stepKind, channel), {
    path: ["stepKind"],
  });
const requestDraftInput = createDraftInput.safeExtend({ replacesId: id.optional() });
const editDraftInput = z.object({
  editedText: z.string().trim().min(1).max(APPROVAL_TEXT_MAX),
  editedSubject: z.string().trim().max(APPROVAL_TEXT_MAX).optional(),
});

/** A new `drafting` draft of the person on the channel, as the kind when given, for writeDraft. */
export async function createDraft(input: z.input<typeof createDraftInput>): Promise<Draft> {
  const { personId, channel, stepKind = null } = parse(createDraftInput, input);
  const { workspaceId } = currentTenant();
  const data = { id: newId(ids.message_draft), workspaceId, personId, channel, stepKind };
  return tenantClient.messageDraft.create({ data });
}

/**
 * A `drafting` draft of the lead, and messaging.draft_requested, from which the worker writes it
 * for the run's user, its sender; with `replacesId`, a regeneration of that draft. Any lead,
 * qualified or not; dossier_lead_not_found for a person without one.
 */
export async function requestDraft(input: z.input<typeof requestDraftInput>): Promise<Draft> {
  const { personId, channel, stepKind, replacesId } = parse(requestDraftInput, input);
  await requireLead(personId);
  const draft = await createDraft({ personId, channel, ...(stepKind && { stepKind }) });
  const { workspaceId, principal } = currentTenant();
  const payload = { workspaceId, draftId: draft.id, personId, userId: principal.userId };
  const event = replacesId === undefined ? payload : { ...payload, replacesId };
  const outbox = outboxWriter(tenantClient, workspaceId);
  await publish(outbox, events["messaging.draft_requested"], event);
  return draft;
}

/** The draft with the id in this workspace, or draft_not_found. */
export async function getDraft(draftId: string): Promise<Draft> {
  // Prisma drops an undefined value from a where: unchecked, that would be any draft.
  const draft = draftId
    ? await tenantClient.messageDraft.findFirst({ where: { id: draftId } })
    : null;
  if (draft === null) throw new AppError(errors.draft_not_found);
  return draft;
}

/** The person's lead drafts, newest first, never a step's; none for a person without one. */
export async function listDrafts(personId: string): Promise<Draft[]> {
  if (!personId) return [];
  return tenantClient.messageDraft.findMany({
    where: { personId, kind: "lead_draft" },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/**
 * The member's own text, and a first email's subject: the draft becomes `edited`, which no write or
 * regeneration changes. draft_not_editable while it is being written; messaging_input_invalid for
 * an empty text or one above the channel's hard limit (hardLimitOf); draft_subject_not_allowed for
 * a subject on any draft but a first email; draft_text_refused, with the gates' issues, for a text
 * or subject checkText refuses (beta-p3-020, gamma-p3-070).
 */
export async function editDraft(
  draftId: string,
  input: { editedText: string; editedSubject?: string },
): Promise<Draft> {
  const { editedText, editedSubject } = parse(editDraftInput, input);
  const draft = await editable(draftId);
  if (editedText.length > hardLimitOf(draft.channel)) {
    throw new AppError(errors.messaging_input_invalid, { details: { fields: ["editedText"] } });
  }
  const stepKind = writtenKindOf(draft) ?? undefined;
  const first = draft.channel === "email" && stepKind === "email_first";
  if (editedSubject !== undefined && !first) throw new AppError(errors.draft_subject_not_allowed);
  const subject = first ? (editedSubject ?? draft.editedSubject ?? draft.subject ?? "") : null;
  const { personId, channel, kind } = draft;
  const email = channel === "email" ? { subject, draftId: draft.id } : {};
  await requirePassingText(editedText, {
    personId,
    channel,
    kind,
    ...(stepKind && { stepKind }),
    ...email,
  });
  const subjectEdit = first ? { editedSubject: subject === draft.subject ? null : subject } : {};
  const data = { status: "edited" as const, editedText, editedAt: new Date(), ...subjectEdit };
  return tenantClient.messageDraft.update({ where: { id: draft.id }, data });
}

/**
 * A new draft of the same person and channel, written unlike this one, which stays as it is
 * (requestDraft). draft_not_editable while this one is being written.
 */
export async function regenerateDraft(draftId: string): Promise<Draft> {
  const { id: replacesId, personId, channel, stepKind } = await editable(draftId);
  const kind = WRITTEN_STEP_KINDS.find((written) => written === stepKind);
  return requestDraft({ personId, channel, ...(kind && { stepKind: kind }), replacesId });
}

/**
 * The draft `failed`, write_failed, with no text, while `drafting`: its writer failed past its
 * attempts. A step's draft publishes messaging.step_draft_ready.
 */
export async function markFailed(draftId: string): Promise<void> {
  const data = { status: "failed" as const, text: null, flagReasons: [{ code: "write_failed" }] };
  const where = { id: draftId, status: "drafting" as const };
  const select = { id: true, stepExecutionId: true } as const;
  const ended = await tenantClient.messageDraft.updateManyAndReturn({ where, data, select });
  await publishStepDraftEnds(
    outboxWriter(tenantClient, currentTenant().workspaceId),
    ended,
    "failed",
  );
}

/**
 * messaging.step_draft_ready for each draft a write just ended, in the writer's transaction: a
 * sequence step's only, which names its step execution; a lead's draft publishes nothing.
 */
export async function publishStepDraftEnds(
  outbox: OutboxWriter,
  ended: readonly { readonly id: string; readonly stepExecutionId: string | null }[],
  status: StepDraftEnd,
): Promise<void> {
  for (const { id, stepExecutionId } of ended) {
    if (stepExecutionId === null) continue;
    const payload = { draftId: id, stepExecutionId, status };
    await publish(outbox, events["messaging.step_draft_ready"], payload);
  }
}

/** The person's lead exists in this workspace, or dossier_lead_not_found. */
export async function requireLead(personId: string): Promise<void> {
  await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === contactsErrors.lead_not_found) {
      throw new AppError(errors.dossier_lead_not_found);
    }
    throw error;
  });
}

/**
 * Deletes the person's drafts, whether contacts still has the person or not; person_not_found for
 * an id that names nobody: this module's step of the deletion script (alpha-p10-030). The rows
 * deleted, by table.
 */
export async function erasePerson(personId: string): Promise<{ message_drafts: number }> {
  // Prisma drops an undefined value from a where: unchecked, that would be every draft.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const { count } = await tenantClient.messageDraft.deleteMany({ where: { personId } });
  return { message_drafts: count };
}

/** The input as the schema reads it, or messaging_input_invalid naming the fields, no value. */
export function parse<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))];
  throw new AppError(errors.messaging_input_invalid, { details: { fields } });
}

/**
 * A lead's draft, once its writer ended: a `drafting` one never is again. A sequence step's draft
 * never: only approvals' path changes it (step_draft_not_editable).
 */
async function editable(draftId: string): Promise<Draft> {
  const draft = await getDraft(draftId);
  if (draft.kind === "outbound_step") throw new AppError(errors.step_draft_not_editable);
  if (draft.status === "drafting") throw new AppError(errors.draft_not_editable);
  return draft;
}

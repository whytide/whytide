// requestStepDraft (README.md "The writer"; docs/flows.md "A step's draft requested"): the draft of
// one step of a sequence, in the caller's tenant run, for campaigns. One draft per step execution:
// a second request answers the first. A connection request's note is empty and `ready` at once,
// with no model call; a message is `drafting`, and messaging.draft_requested makes the worker write
// it as the sender account's owner, from the same person's earlier approved drafts (write.ts).
// stepDrafts reads them back for approvals (beta-p3-020), in the caller's run too. An email step's
// draft (gamma-p3-070) has the channel `email` and the mailbox its caller names, a plain id.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import type { Channel, GateIssue } from "../../schemas/writer.ts";
import { EMAIL_SUBJECT_MAX_CHARACTERS, EMAIL_SUBJECT_MAX_WORDS } from "../gates/constants.ts";
import { editLimitsOf, type GateResult } from "../gates/index.ts";
import { EARLIER_DRAFTS_MAX, STEP_KEYS, STEP_KINDS } from "./constants.ts";
import { kindFits, writtenKindOf } from "./kinds.ts";
import { parse, publishStepDraftEnds, requireLead } from "./store.ts";
import type { DraftStatus } from "./write.ts";

const id = z.string().min(1).max(64);
const requestStepDraftInput = z.object({
  personId: id,
  /** campaigns' `sx_` id of the step's execution. */
  stepExecutionId: id,
  stepKey: z.enum(STEP_KEYS),
  /** The sender account's owner, as whom the text is written. */
  senderUserId: id,
  /** An email step's mailbox, email's id: required for an email key, refused for the others. */
  mailboxId: id.optional(),
  /** The same person's approved drafts of the sequence's earlier steps. */
  earlierDraftIds: z.array(id).max(EARLIER_DRAFTS_MAX).default([]),
});

/**
 * The step execution's draft: the one it has, or a new one. messaging_input_invalid for an unknown
 * step key, more than EARLIER_DRAFTS_MAX earlier ids, or an email key without a mailbox or another
 * key with one; dossier_lead_not_found for a person without a lead.
 */
export async function requestStepDraft(
  input: z.input<typeof requestStepDraftInput>,
): Promise<{ draftId: string }> {
  const request = parse(requestStepDraftInput, input);
  const { personId, stepExecutionId, stepKey, senderUserId, mailboxId, earlierDraftIds } = request;
  const kind = STEP_KINDS[stepKey];
  const email = kind !== "note" && kindFits(kind, "email");
  if (email !== (mailboxId !== undefined)) {
    throw new AppError(errors.messaging_input_invalid, { details: { fields: ["mailboxId"] } });
  }
  const made = await draftOf(stepExecutionId);
  if (made !== null) return { draftId: made };
  await requireLead(personId);
  const { workspaceId } = currentTenant();
  const note = kind === "note";
  const draftId = newId(ids.message_draft);
  const step = { id: draftId, workspaceId, personId, kind: "outbound_step" as const };
  const columns = note
    ? { channel: "linkedin_note" as const, status: "ready" as const, text: "" }
    : email
      ? { channel: "email" as const, mailboxId: mailboxId ?? null }
      : { channel: "linkedin_message" as const };
  const data = { ...step, stepExecutionId, stepKey, ...columns };
  // The partial unique key: a request that lost a race writes nothing and answers the winner's.
  const { count } = await tenantClient.messageDraft.createMany({ data, skipDuplicates: true });
  if (count === 0) {
    const where = { stepExecutionId };
    const winner = await tenantClient.messageDraft.findFirstOrThrow({
      where,
      select: { id: true },
    });
    return { draftId: winner.id };
  }
  const outbox = outboxWriter(tenantClient, workspaceId);
  if (note) {
    await publishStepDraftEnds(outbox, [{ id: draftId, stepExecutionId }], "ready");
  } else {
    const payload = { workspaceId, draftId, personId, userId: senderUserId, earlierDraftIds };
    await publish(outbox, events["messaging.draft_requested"], payload);
  }
  return { draftId };
}

/** A sequence step's draft as approvals reads it: "Up next" and its edit report (beta-p3-020). */
export type StepDraft = {
  readonly id: string;
  readonly personId: string;
  readonly stepExecutionId: string;
  readonly stepKey: string;
  readonly channel: Channel;
  readonly status: DraftStatus;
  /** The final text, the owner's, else the writer's; null for a failed draft. */
  readonly text: string | null;
  /** The characters checkText lets the text have (editLimitsOf): a note from none. */
  readonly minCharacters: number;
  readonly maxCharacters: number;
  /** A first email's final subject, the owner's else the writer's, and its limits; else null. */
  readonly subject: string | null;
  readonly maxSubjectWords: number | null;
  readonly maxSubjectCharacters: number | null;
  /** The writer's last gates, in their order, and why it was flagged or failed. */
  readonly gates: readonly GateResult[];
  readonly flagReasons: readonly (GateIssue | { readonly code: string })[];
  /** The facts its plan cites; none without a plan. */
  readonly factIds: readonly string[];
  readonly editedByUser: boolean;
  readonly editRatio: number | null;
  readonly approvedAt: Date | null;
};

const planFacts = z.object({ factIds: z.array(z.string()) });

/** The workspace's step drafts of the ids, in their order, each once; another id is left out. */
export async function stepDrafts(draftIds: readonly string[]): Promise<StepDraft[]> {
  const wanted = [...new Set(parse(z.array(id), draftIds))];
  if (wanted.length === 0) return [];
  const where = { id: { in: wanted }, kind: "outbound_step" } as const;
  const rows = await tenantClient.messageDraft.findMany({ where });
  const byId = new Map(rows.map((row) => [row.id, row]));
  return wanted.flatMap((draftId) => {
    const row = byId.get(draftId);
    if (row === undefined || row.stepExecutionId === null || row.stepKey === null) return [];
    const { min, max } = editLimitsOf(row.channel, row.kind);
    const plan = planFacts.safeParse(row.plan);
    const failed = row.status === "failed";
    const first = row.channel === "email" && writtenKindOf(row) === "email_first";
    return [
      {
        id: row.id,
        personId: row.personId,
        stepExecutionId: row.stepExecutionId,
        stepKey: row.stepKey,
        channel: row.channel,
        status: row.status,
        text: failed ? null : (row.editedText ?? row.text),
        minCharacters: min,
        maxCharacters: max,
        subject: first && !failed ? (row.editedSubject ?? row.subject) : null,
        maxSubjectWords: first ? EMAIL_SUBJECT_MAX_WORDS : null,
        maxSubjectCharacters: first ? EMAIL_SUBJECT_MAX_CHARACTERS : null,
        // As the writer, the sweep and markFailed store them (write.ts, sweep.ts, store.ts).
        gates: row.gates as unknown as StepDraft["gates"],
        flagReasons: row.flagReasons as unknown as StepDraft["flagReasons"],
        factIds: plan.success ? plan.data.factIds : [],
        editedByUser: row.editedByUser,
        editRatio: row.editRatio === null ? null : Number(row.editRatio),
        approvedAt: row.approvedAt,
      },
    ];
  });
}

/** The id of the step execution's draft in this workspace, or null. */
async function draftOf(stepExecutionId: string): Promise<string | null> {
  const where = { stepExecutionId };
  const draft = await tenantClient.messageDraft.findFirst({ where, select: { id: true } });
  return draft?.id ?? null;
}

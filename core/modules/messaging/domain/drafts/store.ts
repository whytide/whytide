// The drafts' commands and queries (README.md "Routes", docs/flows.md), in the caller's tenant run,
// on the tenant client alone: a requested draft and its event, the reads, a member's edit, a
// regeneration, the workflow's failure mark and the person's erasure; writeDraft writes the rest
// (write.ts). A draft is `drafting` only until its writer ends, and never again.
import { errors as contactsErrors, getLead } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, isAppError, newId, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { CHANNELS, type Channel } from "../../schemas/writer.ts";
import { hardLimitOf } from "../gates/index.ts";
import type { DraftStatus } from "./write.ts";

/** A draft as the routes read it (schemas/drafts.ts); the JSON columns as stored. */
export type Draft = {
  readonly id: string;
  readonly personId: string;
  readonly channel: Channel;
  readonly status: DraftStatus;
  readonly plan: unknown;
  readonly text: string | null;
  readonly editedText: string | null;
  readonly editedAt: Date | null;
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
const createDraftInput = z.object({ personId: id, channel: z.enum(CHANNELS) });
const requestDraftInput = createDraftInput.extend({ replacesId: id.optional() });
const editDraftInput = z.object({ editedText: z.string().trim().min(1).max(4_000) });

/** A new `drafting` draft of the person on the channel, for writeDraft to write. */
export async function createDraft(input: z.input<typeof createDraftInput>): Promise<Draft> {
  const { personId, channel } = parse(createDraftInput, input);
  const { workspaceId } = currentTenant();
  const data = { id: newId(ids.message_draft), workspaceId, personId, channel };
  return tenantClient.messageDraft.create({ data });
}

/**
 * A `drafting` draft of the lead, and messaging.draft_requested, from which the worker writes it
 * for the run's user, its sender; with `replacesId`, a regeneration of that draft. Any lead,
 * qualified or not; dossier_lead_not_found for a person without one.
 */
export async function requestDraft(input: z.input<typeof requestDraftInput>): Promise<Draft> {
  const { personId, channel, replacesId } = parse(requestDraftInput, input);
  await getLead(personId).catch((error: unknown) => {
    if (isAppError(error) && error.code === contactsErrors.lead_not_found) {
      throw new AppError(errors.dossier_lead_not_found);
    }
    throw error;
  });
  const draft = await createDraft({ personId, channel });
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

/** The person's drafts, newest first; none for a person without one. */
export async function listDrafts(personId: string): Promise<Draft[]> {
  if (!personId) return [];
  return tenantClient.messageDraft.findMany({
    where: { personId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

/**
 * The member's own text: the draft becomes `edited`, which no write or regeneration changes.
 * draft_not_editable while it is being written; messaging_input_invalid for an empty text or one
 * above the channel's hard limit (hardLimitOf).
 */
export async function editDraft(draftId: string, input: { editedText: string }): Promise<Draft> {
  const { editedText } = parse(editDraftInput, input);
  const draft = await editable(draftId);
  if (editedText.length > hardLimitOf(draft.channel)) {
    throw new AppError(errors.messaging_input_invalid, { details: { fields: ["editedText"] } });
  }
  const data = { status: "edited" as const, editedText, editedAt: new Date() };
  return tenantClient.messageDraft.update({ where: { id: draft.id }, data });
}

/**
 * A new draft of the same person and channel, written unlike this one, which stays as it is
 * (requestDraft). draft_not_editable while this one is being written.
 */
export async function regenerateDraft(draftId: string): Promise<Draft> {
  const { id: replacesId, personId, channel } = await editable(draftId);
  return requestDraft({ personId, channel, replacesId });
}

/** The draft `failed`, write_failed, while `drafting`: its writer failed past its attempts. */
export async function markFailed(draftId: string): Promise<void> {
  const data = { status: "failed" as const, flagReasons: [{ code: "write_failed" }] };
  await tenantClient.messageDraft.updateMany({ where: { id: draftId, status: "drafting" }, data });
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

/** The draft, once its writer ended: a `drafting` one never is again. */
async function editable(draftId: string): Promise<Draft> {
  const draft = await getDraft(draftId);
  if (draft.status === "drafting") throw new AppError(errors.draft_not_editable);
  return draft;
}

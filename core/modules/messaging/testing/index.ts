// messaging's test helpers (README.md "Testing"), `@whytide/messaging/testing`, in test files only:
// useMessagingClient(asRole("app")) makes buildDossier's run use the test file's schema; and a
// person's draft in any state, createMessageDraft, or a `drafting` one written as its writer leaves
// it, writeMessageDraft, on asRole("app") of @whytide/db/testing, so the test file calls
// withTestDb() first, or on the client given: the web's e2e api seeds the draft panel's drafts so,
// and stands in for the worker, which it does not run. createStepDraft writes a sequence step's
// draft in any state, for approvals' and campaigns' tests.
import { Prisma, type TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { STEP_KINDS, type StepKey } from "../domain/drafts/constants.ts";
import type { DraftStatus } from "../domain/drafts/write.ts";
import { ids } from "../ids.ts";
import {
  type Channel,
  GATES,
  type GateIssue,
  type GateName,
  type PlanOutput,
} from "../schemas/writer.ts";

export { useClient as useMessagingClient } from "../domain/dossier/build.ts";

/** A draft's columns as its writer, or a member's edit, leaves them. */
export type SeededDraft = {
  readonly status?: DraftStatus;
  readonly plan?: PlanOutput | null;
  readonly text?: string | null;
  readonly editedText?: string | null;
  readonly gates?: readonly { readonly gate: GateName; readonly issues: readonly GateIssue[] }[];
  readonly flagReasons?: readonly (GateIssue | { readonly code: string })[];
  readonly dossierHash?: string | null;
  /** The last call's model and prompt version: `fake-model` and 1 unless given, null included. */
  readonly modelId?: string | null;
  readonly promptVersion?: number | null;
};
type Client = Pick<TenantClient, "messageDraft">;

/**
 * A draft of the person, a note `ready` with every gate passed unless the input says otherwise; an
 * `edited` one edited now. Its id.
 */
export async function createMessageDraft(
  input: SeededDraft & {
    readonly workspaceId: string;
    readonly personId: string;
    readonly channel?: Channel;
    readonly createdAt?: Date;
  },
  client: Client = asRole("app"),
): Promise<string> {
  const { workspaceId, personId, channel = "linkedin_note", createdAt } = input;
  const id = newId(ids.message_draft);
  const data = { id, workspaceId, personId, channel, createdAt, ...columnsOf(input) };
  await client.messageDraft.create({ data });
  return id;
}

/**
 * A sequence step's draft of the person: a message (`message_1` unless given), or the note of
 * `connect`, `ready` with every gate passed unless the input says otherwise; an `approved` one
 * approved now. Its id.
 */
export async function createStepDraft(
  input: SeededDraft & {
    readonly workspaceId: string;
    readonly personId: string;
    readonly stepExecutionId: string;
    readonly stepKey?: StepKey;
    readonly createdAt?: Date;
  },
  client: Client = asRole("app"),
): Promise<string> {
  const { workspaceId, personId, stepExecutionId, stepKey = "message_1", createdAt } = input;
  const channel = STEP_KINDS[stepKey] === "note" ? "linkedin_note" : "linkedin_message";
  const columns = columnsOf(input);
  const approvedAt = columns.status === "approved" ? new Date() : null;
  const id = newId(ids.message_draft);
  const step = { kind: "outbound_step" as const, stepExecutionId, stepKey, approvedAt };
  await client.messageDraft.create({
    data: { id, workspaceId, personId, channel, createdAt, ...step, ...columns },
  });
  return id;
}

/** The draft, if it is `drafting` still, written as its writer leaves it; the rows written, 0 or 1. */
export async function writeMessageDraft(
  draftId: string,
  draft: SeededDraft,
  client: Client = asRole("app"),
): Promise<number> {
  const where = { id: draftId, status: "drafting" as const };
  return (await client.messageDraft.updateMany({ where, data: columnsOf(draft) })).count;
}

/** The columns; the calls' decision records are the test's. */
function columnsOf(draft: SeededDraft) {
  const { status = "ready", plan = null, text = null, editedText = null } = draft;
  const { modelId = "fake-model", promptVersion = 1 } = draft;
  const decisionRecordId = "dr_test";
  return {
    ...{ status, text, editedText, dossierHash: draft.dossierHash ?? null },
    plan: plan === null ? Prisma.DbNull : { ...plan, decisionRecordId },
    editedAt: status === "edited" ? new Date() : null,
    ...{ modelId, promptVersion, decisionRecordId },
    gates: (draft.gates ?? GATES.map((gate) => ({ gate, issues: [] }))) as Prisma.InputJsonValue,
    flagReasons: (draft.flagReasons ?? []) as Prisma.InputJsonValue,
  };
}

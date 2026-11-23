// messaging's test helpers (README.md "Testing"), `@whytide/messaging/testing`, in test files only:
// useMessagingClient(asRole("app")) makes buildDossier's run use the test file's schema; and a
// person's draft in any state, createMessageDraft, or a `drafting` one written as its writer leaves
// it, writeMessageDraft, on asRole("app") of @whytide/db/testing, so the test file calls
// withTestDb() first, or on the client given: the web's e2e api seeds the draft panel's drafts so,
// and stands in for the worker, which it does not run. createStepDraft writes a sequence step's
// draft in any state, for approvals' and campaigns' tests; an email key's (gamma-p3-070) with its
// mailbox. A draft's gates are, unless given, the ones its writer keeps for it, each passed.
import { Prisma, type TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { STEP_KINDS, type StepKey, type WrittenStepKind } from "../domain/drafts/constants.ts";
import type { DraftStatus } from "../domain/drafts/write.ts";
import { gatesOf } from "../domain/gates/index.ts";
import { ids } from "../ids.ts";
import type { Channel, GateIssue, GateName, PlanOutput } from "../schemas/writer.ts";

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
  /** An email's subject as written, and the member's or the owner's. */
  readonly subject?: string | null;
  readonly editedSubject?: string | null;
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
    /** The kind a lead's draft is written as; none unless given. */
    readonly stepKind?: WrittenStepKind;
    readonly createdAt?: Date;
  },
  client: Client = asRole("app"),
): Promise<string> {
  const { workspaceId, personId, channel = "linkedin_note", stepKind = null, createdAt } = input;
  const id = newId(ids.message_draft);
  const first = (stepKind ?? "email_first") === "email_first";
  const columns = columnsOf(input, gatesOf(channel, { first }));
  const data = { id, workspaceId, personId, channel, stepKind, createdAt, ...columns };
  await client.messageDraft.create({ data });
  return id;
}

/**
 * A sequence step's draft of the person: a message (`message_1` unless given), the note of
 * `connect`, or an email key's email from its mailbox (`mbx_test` unless given), `ready` with
 * every gate passed unless the input says otherwise; an `approved` one approved now. Its id.
 */
export async function createStepDraft(
  input: SeededDraft & {
    readonly workspaceId: string;
    readonly personId: string;
    readonly stepExecutionId: string;
    readonly stepKey?: StepKey;
    readonly mailboxId?: string;
    readonly createdAt?: Date;
  },
  client: Client = asRole("app"),
): Promise<string> {
  const { workspaceId, personId, stepExecutionId, stepKey = "message_1", createdAt } = input;
  const kind = STEP_KINDS[stepKey];
  const email = kind === "email_first" || kind === "email_follow_up";
  const channel = email ? "email" : kind === "note" ? "linkedin_note" : "linkedin_message";
  const mailboxId = email ? (input.mailboxId ?? "mbx_test") : null;
  const columns = columnsOf(
    input,
    gatesOf(channel, { first: kind === "email_first", mailbox: email }),
  );
  const approvedAt = columns.status === "approved" ? new Date() : null;
  const id = newId(ids.message_draft);
  const step = { kind: "outbound_step" as const, stepExecutionId, stepKey, mailboxId, approvedAt };
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
  const row = await client.messageDraft.findFirst({ where, select: { channel: true } });
  const columns = columnsOf(draft, gatesOf(row?.channel ?? "linkedin_note", { first: true }));
  return (await client.messageDraft.updateMany({ where, data: columns })).count;
}

/** The columns, the gates the given ones unless given; the calls' decision records are the test's. */
function columnsOf(draft: SeededDraft, gates: readonly GateName[]) {
  const { status = "ready", plan = null, text = null, editedText = null } = draft;
  const { modelId = "fake-model", promptVersion = 1 } = draft;
  const { subject = null, editedSubject = null } = draft;
  const decisionRecordId = "dr_test";
  return {
    ...{ status, text, editedText, dossierHash: draft.dossierHash ?? null },
    ...{ subject, editedSubject },
    plan: plan === null ? Prisma.DbNull : { ...plan, decisionRecordId },
    editedAt: status === "edited" ? new Date() : null,
    ...{ modelId, promptVersion, decisionRecordId },
    gates: (draft.gates ?? gates.map((gate) => ({ gate, issues: [] }))) as Prisma.InputJsonValue,
    flagReasons: (draft.flagReasons ?? []) as Prisma.InputJsonValue,
  };
}

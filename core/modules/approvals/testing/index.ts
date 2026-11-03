// approvals' test helpers (README.md "Testing"), `@whytide/approvals/testing`, in test files only:
// createApprovalItem writes an item in any state straight to the table, for approvals', campaigns'
// and the web's e2e tests; on the client given, else on the one useApprovalsClient set, else on
// asRole("app") of @whytide/db/testing, so the test file calls withTestDb() first. approvals opens no
// run of its own (every command runs in its caller's), so the factory's client is the only one.
// attachStepDraft does the subscriber's work, where no worker runs: the web's e2e api, whose
// drafting item gets its draft once the e2e module has written it.
import { createHash } from "node:crypto";
import type { TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { type ActionType, DECISION_ORIGIN, type ItemStatus } from "../domain/items/constants.ts";
import { attachDraft } from "../domain/items/open.ts";
import { ids } from "../ids.ts";

type Client = Pick<TenantClient, "approvalItem">;
let given: Client | undefined;

/** The client createApprovalItem writes on when none is given; undefined restores asRole("app"). */
export function useApprovalsClient(client: Client | undefined): void {
  given = client;
}

/** An item's columns as a test seeds them; each has a default that the table's CHECKs accept. */
export type SeededItem = {
  readonly workspaceId: string;
  readonly personId: string;
  readonly senderAccountId: string;
  readonly stepExecutionId: string;
  /** `message_1` unless given. */
  readonly stepKey?: string;
  /** `invite` for `connect`, else `message`, unless given. */
  readonly actionType?: ActionType;
  readonly draftId?: string | null;
  /** Now unless given. */
  readonly scheduledFor?: Date;
  /** `pending` unless given. */
  readonly status?: ItemStatus;
  /** An approved item's: the hash of the empty note unless given. */
  readonly approvedContentHash?: string;
  /** A decided item's: `usr_test` and now unless given. */
  readonly decidedBy?: string;
  readonly decidedAt?: Date;
  readonly waitCode?: string | null;
  readonly waitUntil?: Date | null;
  readonly createdAt?: Date;
};

/** An item written straight to the table, as the commands leave one. Its id. */
export async function createApprovalItem(
  input: SeededItem,
  client: Client = given ?? asRole("app"),
): Promise<string> {
  const { workspaceId, personId, senderAccountId, stepExecutionId } = input;
  const { stepKey = "message_1", status = "pending", draftId = null } = input;
  const actionType = input.actionType ?? (stepKey === "connect" ? "invite" : "message");
  const decided = status === "approved" || status === "skipped";
  const id = newId(ids.approval_item);
  await client.approvalItem.create({
    data: {
      ...{ id, workspaceId, personId, senderAccountId, stepExecutionId, stepKey, actionType },
      ...{ status, draftId, scheduledFor: input.scheduledFor ?? new Date() },
      approvedContentHash: status === "approved" ? (input.approvedContentHash ?? sha256("")) : null,
      decidedBy: decided ? (input.decidedBy ?? "usr_test") : null,
      decidedAt: decided ? (input.decidedAt ?? new Date()) : null,
      decisionOrigin: decided ? DECISION_ORIGIN : null,
      waitCode: input.waitCode ?? null,
      waitUntil: input.waitUntil ?? null,
      ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    },
  });
  return id;
}

/**
 * messaging.step_draft_ready's work (events.ts), the draft ended: the step's pending item without a
 * draft gets it. The items changed, 0 or 1.
 */
export function attachStepDraft(
  ended: { readonly draftId: string; readonly stepExecutionId: string },
  client: Client = given ?? asRole("app"),
): Promise<number> {
  return attachDraft(client, ended);
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The setup the report's test files share (tests/report.test.ts, tests/report-cli.test.ts), on top of
// tests/fixtures.ts, each file on its own schema (withTestDb, called by the file): linkedin's `ok` row
// of a send as its send activity writes it, a step sent as campaigns' sender settles it with what the
// gate stored, a connection request approved and then sent, and an entry of the never-contact list
// made and lifted at the instants given (contacts' index offers this module the opt-out only: the
// entry is made as one, then moved to the block list, its hash kept).
import { approvedContent } from "@whytide/approvals";
import { addOptOut } from "@whytide/contacts";
import type { Prisma } from "@whytide/db";
import { ids as linkedinIds } from "@whytide/linkedin";
import { newId } from "@whytide/platform";
import { type Fixture, fixture } from "./fixtures.ts";

export const EPOCH = new Date(0);
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** A text the steps' drafts carry, which no line of the report may hold. */
export const TEXT = "Noor, how does your team follow up on warm leads today?";

type Kind = "invite" | "message" | "withdraw";
/** An approved step's send: when, and the item and the hash it carried, the approval's by default. */
export type Sent = { readonly at?: Date; readonly item?: string; readonly hash?: string };
export type ReportFixture = Fixture & {
  readonly workspaceId: string;
  /** linkedin's `ok` row of a send, as its send activity writes it: its id. */
  readonly logSend: (row: {
    accountId: string;
    stepExecutionId: string | null;
    at: Date;
    kind?: Kind;
  }) => Promise<string>;
  /** The step `succeeded` at `at` with the checks given, and its `ok` row: the row's id. */
  readonly sendStep: (
    id: string,
    sent: { at: Date; jitChecks?: Prisma.InputJsonObject },
  ) => Promise<string>;
  /**
   * A connection request queued, approved and decided, then sent with the item and the hash the
   * gate stores, a minute after the approval unless `at` is given: its row's id and the instant.
   */
  readonly approvedSend: (id: string, sent?: Sent) => Promise<{ rowId: string; at: Date }>;
  /** The person's entry: an opt-out, or a block, created at `createdAt`, lifted at `removedAt`. */
  readonly suppress: (
    personId: string,
    entry: { layer?: "opt_out" | "blocklist"; createdAt: Date; removedAt?: Date },
  ) => Promise<void>;
};

export function reportFixture(workspaceId: string): ReportFixture {
  const base = fixture(workspaceId);
  const { app, run } = base;

  async function logSend(row: {
    accountId: string;
    stepExecutionId: string | null;
    at: Date;
    kind?: Kind;
  }): Promise<string> {
    const id = newId(linkedinIds.sender_action_log);
    const { accountId: senderAccountId, stepExecutionId: objectRef, at, kind = "invite" } = row;
    await app().senderActionLog.create({
      data: { id, workspaceId, senderAccountId, kind, objectRef, count: 1, outcome: "ok", at },
    });
    return id;
  }

  async function sendStep(
    id: string,
    sent: { at: Date; jitChecks?: Prisma.InputJsonObject },
  ): Promise<string> {
    const step = await app().stepExecution.update({
      where: { id },
      data: { status: "succeeded", executedAt: sent.at, jitChecks: sent.jitChecks ?? {} },
    });
    const kind = step.actionType;
    return logSend({ accountId: step.senderAccountId, stepExecutionId: id, at: sent.at, kind });
  }

  async function approvedSend(id: string, sent: Sent = {}): Promise<{ rowId: string; at: Date }> {
    await base.approved(id);
    const approval = await run(() => approvedContent(id));
    if (approval === null) throw new Error("approvedSend: not approved");
    const at = sent.at ?? new Date(approval.approvedAt.getTime() + MINUTE_MS);
    const jitChecks = {
      approvalItemId: sent.item ?? approval.approvalItemId,
      contentHash: sent.hash ?? approval.contentHash,
    };
    return { rowId: await sendStep(id, { at, jitChecks }), at };
  }

  async function suppress(
    personId: string,
    entry: { layer?: "opt_out" | "blocklist"; createdAt: Date; removedAt?: Date },
  ): Promise<void> {
    const added = await run(() => addOptOut(personId, { source: "system" }));
    const { layer = "opt_out", createdAt, removedAt = null } = entry;
    await app().suppressionEntry.update({
      where: { id: added.entry.id },
      data: { layer, createdAt, removedAt },
    });
  }

  return { ...base, workspaceId, logSend, sendStep, approvedSend, suppress };
}

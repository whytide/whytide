// The setup the report's test files share (tests/report.test.ts, tests/report-cli.test.ts), on top of
// tests/fixtures.ts, each file on its own schema (withTestDb, called by the file): linkedin's `ok` row
// of a send as its send activity writes it, a step sent as campaigns' sender settles it with what the
// gate stored, a connection request approved and then sent, and an entry of the never-contact list
// made and lifted at the instants given (contacts' index offers this module the opt-out only: the
// entry is made as one, then moved to the block list, its hash kept). gamma-p4-070: the seeded
// campaign's mode and lock set, and a follow-up approved by the mode, then sent with the mode the
// gate stores. gamma-p7-050: a block on one channel.
import { approvedContent } from "@whytide/approvals";
import { attachStepDraft } from "@whytide/approvals/testing";
import { addOptOut, type SuppressionChannel } from "@whytide/contacts";
import type { Prisma } from "@whytide/db";
import { ids as linkedinIds } from "@whytide/linkedin";
import { newId } from "@whytide/platform";
import type { ApprovalMode } from "../domain/approval-mode/constants.ts";
import { linkedinActionType, linkedinSenderAccount } from "../domain/steps/actions.ts";
import { TEMPLATE_ID } from "../domain/template/constants.ts";
import { type Fixture, fixture } from "./fixtures.ts";

export const EPOCH = new Date(0);
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** A text the steps' drafts carry, which no line of the report may hold. */
export const TEXT = "Noor, how does your team follow up on warm leads today?";

type Kind = "invite" | "message" | "withdraw";
/** A never-contact entry as a test makes it. */
type Entry = {
  layer?: "opt_out" | "blocklist";
  createdAt: Date;
  removedAt?: Date;
  channel?: SuppressionChannel;
};
/** An approved step's send: when, and the item and the hash it carried, the approval's by default. */
export type Sent = { readonly at?: Date; readonly item?: string; readonly hash?: string };
/** A mode's send: `approval` merged over the checks the gate stores, null for a send stored without. */
export type ModeSent = Sent & { readonly approval?: Prisma.InputJsonObject | null };
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
  /**
   * The person's entry: an opt-out, or a block, created at `createdAt`, lifted at `removedAt`; a
   * block on the channel given, every one by default (gamma-p7-050).
   */
  readonly suppress: (personId: string, entry: Entry) => Promise<void>;
  /** The seeded campaign's mode and the end of its lock, as a change and the days leave them. */
  readonly setMode: (mode: ApprovalMode, lockedUntil: Date) => Promise<void>;
  /**
   * A follow-up queued in review_first_touches once its enrollment's earlier messages went out
   * (`succeeded`, as the mode needs, review-gaps), its draft ended `ready` with TEXT and approved by
   * the mode with its line, decided, then sent with the item, the hash and the gate's approval
   * checks (the mode, a follow-up, the mode's origin), a minute after the approval unless `at` is
   * given: its row's id and the instant.
   */
  readonly modeApprovedSend: (id: string, sent?: ModeSent) => Promise<{ rowId: string; at: Date }>;
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
    const kind = linkedinActionType(step);
    return logSend({
      accountId: linkedinSenderAccount(step),
      stepExecutionId: id,
      at: sent.at,
      kind,
    });
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

  async function suppress(personId: string, entry: Entry): Promise<void> {
    const added = await run(() => addOptOut(personId, { source: "system" }));
    const { layer = "opt_out", createdAt, removedAt = null, channel = "all" } = entry;
    await app().suppressionEntry.update({
      where: { id: added.entry.id },
      data: { layer, createdAt, removedAt, channel },
    });
  }

  async function setMode(mode: ApprovalMode, lockedUntil: Date): Promise<void> {
    const where = { workspaceId, keyRef: TEMPLATE_ID };
    const data = { approvalMode: mode, reviewLockedUntil: lockedUntil };
    const { count } = await app().campaign.updateMany({ where, data });
    if (count !== 1) throw new Error("setMode: no seeded campaign");
  }

  async function modeApprovedSend(
    id: string,
    sent: ModeSent = {},
  ): Promise<{ rowId: string; at: Date }> {
    const { enrollmentId, actionType, position } = await app().stepExecution.findUniqueOrThrow({
      where: { id },
    });
    const earlier = { enrollmentId, actionType, position: { lt: position } };
    await app().stepExecution.updateMany({ where: earlier, data: { status: "succeeded" } });
    await base.dueAt(id, new Date());
    if ((await base.queue(id)) !== "opened") throw new Error("modeApprovedSend: not opened");
    const draft = await app().messageDraft.findFirstOrThrow({ where: { stepExecutionId: id } });
    const ready = { status: "ready", text: TEXT } as const;
    await app().messageDraft.update({ where: { id: draft.id }, data: ready });
    // The mode approves in the caller's tenant run, as the subscriber's delivery has one.
    await run((tx) => attachStepDraft({ draftId: draft.id, stepExecutionId: id }, tx));
    if ((await base.decide(id)) !== "scheduled") throw new Error("modeApprovedSend: not decided");
    const approval = await run(() => approvedContent(id, { allowMode: true }));
    if (approval?.origin !== "approval_mode") throw new Error("modeApprovedSend: not the mode's");
    const { approvalItemId, contentHash } = approval;
    const at = sent.at ?? new Date(approval.approvedAt.getTime() + MINUTE_MS);
    const checks = { approvalItemId, status: "approved", contentHash, firstTouch: false };
    const stored = { ...checks, mode: "review_first_touches", origin: "approval_mode" };
    const jitChecks = {
      approvalItemId: sent.item ?? approvalItemId,
      contentHash: sent.hash ?? contentHash,
      ...(sent.approval !== null && { approval: { ...stored, ...sent.approval } }),
    };
    return { rowId: await sendStep(id, { at, jitChecks }), at };
  }

  return {
    ...{ ...base, workspaceId, logSend, sendStep, approvedSend, suppress },
    ...{ setMode, modeApprovedSend },
  };
}

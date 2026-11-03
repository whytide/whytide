// sends_without_approval (README.md "Commands"; beta's rules we keep: nothing is sent without the
// tester's per-message approval), in the caller's tenant run: for each invite or message that went
// out, approvals' approvedContent of its step must answer, with the item and the hash the gate stored
// with the send (jit_checks, domain/send/gate.ts), approved at or before the send. The approved text
// is read to compare its answer and never kept or returned.
import { approvedContent } from "@whytide/approvals";
import type { Prisma } from "@whytide/db";
import type { ApprovalBreach } from "./constants.ts";
import type { Send } from "./sends.ts";

/** A send that breaks a zero: its step, why, and the send's instant. */
export type Violation = {
  readonly stepExecutionId: string;
  readonly reason: string;
  readonly at: Date;
};

/** The sends approvals does not cover, oldest first, each with its reason (the file's header). */
export async function sendsWithoutApproval(sends: readonly Send[]): Promise<Violation[]> {
  const found: Violation[] = [];
  for (const { row, step } of sends) {
    const reason = await breachOf(step.id, step.jitChecks, row.at);
    if (reason !== null) found.push({ stepExecutionId: step.id, reason, at: row.at });
  }
  return found;
}

/** The first breach: no approved text, then another item or hash than the send's, then too late. */
async function breachOf(
  stepExecutionId: string,
  jitChecks: Prisma.JsonValue | null,
  at: Date,
): Promise<ApprovalBreach | null> {
  const approved = await approvedContent(stepExecutionId);
  if (approved === null) return "no_approval";
  const sent = sentWith(jitChecks);
  if (approved.approvalItemId !== sent.approvalItemId) return "item_mismatch";
  if (approved.contentHash !== sent.contentHash) return "item_mismatch";
  if (approved.approvedAt.getTime() > at.getTime()) return "approved_after_send";
  return null;
}

/** The item and the hash the send carried, as the gate before the call stored them; null if absent. */
function sentWith(jitChecks: Prisma.JsonValue | null): {
  readonly approvalItemId: string | null;
  readonly contentHash: string | null;
} {
  const checks =
    typeof jitChecks === "object" && jitChecks !== null && !Array.isArray(jitChecks)
      ? jitChecks
      : {};
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { approvalItemId: text(checks.approvalItemId), contentHash: text(checks.contentHash) };
}

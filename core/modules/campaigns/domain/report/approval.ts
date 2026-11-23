// sends_without_approval (README.md "Commands"; beta's rules we keep: nothing is sent without the
// tester's per-message approval), in the caller's tenant run: for each invite or message that went
// out, approvals' approvedContent of its step must answer, with the item and the hash the gate stored
// with the send (jit_checks, domain/send/gate.ts), approved at or before the send. The approved text
// is read to compare its answer and never kept or returned. gamma-p4-070: each send's required
// approval comes from the mode and the first touch the gate stored with it (jit_checks.approval),
// but a send before its campaign's review_locked_until, of a campaign not found, or stored with no
// mode (every send before gamma-p4-070) counts as review_everything whatever the row says: the
// stored lock is trusted over jit_checks. The mode's approval where a person's was needed is
// mode_not_allowed; each violation names the mode it counts in.
import { approvedContent } from "@whytide/approvals";
import { type Prisma, tenantClient } from "@whytide/db";
import {
  type ApprovalMode,
  type ApprovalRequirement,
  MODE_ORIGIN,
  PERSON_OR_MODE,
  REVIEW_EVERYTHING,
} from "../approval-mode/constants.ts";
import { effectiveMode } from "../approval-mode/mode.ts";
import { approvalRequired } from "../steps/actions.ts";
import type { ApprovalBreach } from "./constants.ts";
import type { Send } from "./sends.ts";

/** A send that breaks a zero: its step, why, the send's instant, and for an approval its mode. */
export type Violation = {
  readonly stepExecutionId: string;
  readonly reason: string;
  readonly at: Date;
  readonly mode?: ApprovalMode;
};

/** The sends approvals does not cover, oldest first, each with its reason and mode (the header). */
export async function sendsWithoutApproval(sends: readonly Send[]): Promise<Violation[]> {
  const locks = await locksOf(sends);
  const found: Violation[] = [];
  for (const { row, step } of sends) {
    const stored = storedApproval(step.jitChecks);
    const lockedUntil = locks.get(step.templateId);
    const mode =
      lockedUntil === undefined
        ? REVIEW_EVERYTHING
        : effectiveMode({ approvalMode: stored.mode, reviewLockedUntil: lockedUntil }, row.at);
    const required = approvalRequired(
      { actionType: row.kind, firstTouch: stored.firstTouch },
      mode,
    );
    const reason = await breachOf(step.id, step.jitChecks, row.at, required);
    if (reason !== null) found.push({ stepExecutionId: step.id, reason, at: row.at, mode });
  }
  return found;
}

/**
 * The first breach: no approved text, the mode's approval where a person's was needed, then another
 * item or hash than the send's, then too late.
 */
async function breachOf(
  stepExecutionId: string,
  jitChecks: Prisma.JsonValue | null,
  at: Date,
  required: ApprovalRequirement,
): Promise<ApprovalBreach | null> {
  const approved = await approvedContent(stepExecutionId, { allowMode: true });
  if (approved === null) return "no_approval";
  if (approved.origin === MODE_ORIGIN && required !== PERSON_OR_MODE) return "mode_not_allowed";
  const sent = sentWith(jitChecks);
  if (approved.approvalItemId !== sent.approvalItemId) return "item_mismatch";
  if (approved.contentHash !== sent.contentHash) return "item_mismatch";
  if (approved.approvedAt.getTime() > at.getTime()) return "approved_after_send";
  return null;
}

/** The end of each sent step's campaign's lock, by its key_ref; a campaign not found has none. */
async function locksOf(sends: readonly Send[]): Promise<Map<string, Date>> {
  const keys = [...new Set(sends.map(({ step }) => step.templateId))];
  if (keys.length === 0) return new Map();
  const campaigns = await tenantClient.campaign.findMany({
    where: { keyRef: { in: keys } },
    select: { keyRef: true, reviewLockedUntil: true },
  });
  return new Map(campaigns.map(({ keyRef, reviewLockedUntil }) => [keyRef, reviewLockedUntil]));
}

/**
 * The mode and the first touch the gate stored with the send (jit_checks.approval): no mode, "", for
 * a send stored before gamma-p4-070, and a first touch unless it says otherwise (fail closed).
 */
function storedApproval(jitChecks: Prisma.JsonValue | null): {
  readonly mode: string;
  readonly firstTouch: boolean;
} {
  const approval = objectOf(objectOf(jitChecks).approval);
  const mode = typeof approval.mode === "string" ? approval.mode : "";
  return { mode, firstTouch: approval.firstTouch !== false };
}

/** The item and the hash the send carried, as the gate before the call stored them; null if absent. */
function sentWith(jitChecks: Prisma.JsonValue | null): {
  readonly approvalItemId: string | null;
  readonly contentHash: string | null;
} {
  const checks = objectOf(jitChecks);
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return { approvalItemId: text(checks.approvalItemId), contentHash: text(checks.contentHash) };
}

/** A JSON object as it is, anything else as an empty one. */
function objectOf(value: Prisma.JsonValue | null | undefined): Record<string, Prisma.JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

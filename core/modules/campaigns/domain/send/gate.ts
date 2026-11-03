// The gate right before the call (docs/flows.md "The sender", step 6), in one tenant run: the gate
// once more on the claimed step, reading the primary as it does; then the approved text's hash it
// answers against the hash of the text in the request file. A mismatch is content_changed, the step
// skipped as the gate's own approval block skips it, and nothing is sent. A pass writes what the
// gate saw on the step, with the approval item and the hash sent. A block frees the slot and the
// credits; touched_today, which leaves the step `executing`, puts it back to be placed another day.
// A step more than a gap past its time or its slot's, after a stop since the claim, goes back to the
// plan (recover.ts putBackLate, beta-p4-040).
import { createHash } from "node:crypto";
import { type Prisma, tenantClient } from "@whytide/db";
import { STEP_NOT_READY } from "../gate/constants.ts";
import { checkGate, type GateReason } from "../gate/gate.ts";
import { needsApproval } from "../steps/actions.ts";
import { SKIPPED_STEP_FIELDS, skipStep } from "../steps/skip.ts";
import { putBackLate } from "./recover.ts";
import { type Holds, releaseHolds, waitAgain } from "./release.ts";

export type CallGate =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: GateReason };

/** The gate's own skips are the system's. */
const SYSTEM = { type: "system" } as const;

/** The hex SHA-256 of the text in UTF-8, as approvals hashes the approved text. */
export const hashOf = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** Whether the claimed step may be sent at `at`, its file's text hashing to `fileHash` (the header). */
export async function gateBeforeCall(
  input: {
    readonly stepExecutionId: string;
    readonly holds: Holds;
    readonly fileHash: string | null;
  },
  at: Date,
): Promise<CallGate> {
  const { stepExecutionId: id, holds, fileHash } = input;
  const answer = await checkGate(id, { at });
  if (!answer.pass) return blockClaimed(id, holds, answer.reason);
  const where = { id, status: "executing" } as const;
  const step = await tenantClient.stepExecution.findFirst({ where, select: SKIPPED_STEP_FIELDS });
  if (step === null) return blockClaimed(id, holds, STEP_NOT_READY);
  if (await putBackLate(id, holds, at)) return { pass: false, reason: STEP_NOT_READY };
  const approval = answer.checks.approval;
  const contentHash = approval?.contentHash ?? null;
  if (needsApproval(step.actionType) && (contentHash === null || contentHash !== fileHash)) {
    const jitChecks = { ...answer.checks, fileHash } as Prisma.InputJsonObject;
    const skip = { reason: "content_changed", at, actor: SYSTEM, jitChecks } as const;
    await skipStep(tenantClient, { ...step, status: "executing" }, skip);
    return blockClaimed(id, holds, "content_changed");
  }
  const sent = { approvalItemId: approval?.approvalItemId ?? null, contentHash: fileHash };
  const jitChecks = { ...answer.checks, ...sent } as Prisma.InputJsonObject;
  await tenantClient.stepExecution.updateMany({ where, data: { jitChecks } });
  return { pass: true };
}

/**
 * A claimed step that does not go on to the call: its holds freed; one a block left `executing`
 * (touched_today) back to `scheduled`, unplaced, with the reason.
 */
export async function blockClaimed(
  id: string,
  holds: Holds,
  reason: GateReason,
): Promise<{ readonly pass: false; readonly reason: GateReason }> {
  await releaseHolds(holds);
  if (reason !== STEP_NOT_READY) await waitAgain({ id, status: "executing" }, reason);
  return { pass: false, reason };
}

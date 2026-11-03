// The action log (docs/concepts.md "Action log"): a row per reservation, per read, per send and per
// status check of a sender account, with its count and outcome, written in the caller's tenant run.
// The object is a post URL, a person id or a send's step execution (schemas/quota.ts isObjectRef); no
// log line and no metric label carries it. The table takes no UPDATE from app (the migration
// linkedin_send_reservations). The metric is linkedin's own activities' to add, once their run has
// returned (countAction), so a run that rolls back counts nothing; the rows written in another
// module's run, its reservations, are counted in the table only.
import { tenantClient } from "@whytide/db";
import { currentTenant, isAppError, newId } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { ids } from "../../ids.ts";
import { linkedinMetrics } from "../../metrics.ts";
import {
  type ActionOutcome,
  type actionKinds,
  isActionOutcome,
  type LogInput,
  logInput,
} from "../../schemas/quota.ts";
import { findAccount } from "../accounts.ts";
import { now } from "../clock.ts";
import { parseInput } from "../input.ts";

export type ActionEntry = {
  readonly kind: (typeof actionKinds)[number];
  readonly objectRef?: string | undefined;
  readonly count: number;
  readonly outcome: ActionOutcome;
  /** An invite carrying a note. */
  readonly withNote?: boolean | undefined;
  /**
   * The call the row answers, the same on each of its attempts, which the third error counts once
   * (health/signals.ts): a signals read's file key, a send's step execution; none, its own call.
   */
  readonly callRef?: string | undefined;
};
/** A row as written: what the metric counts. */
export type LoggedAction = Pick<ActionEntry, "kind" | "count" | "outcome"> & {
  readonly id: string;
};

/** A read made, a send, or a status check, on an account of the run's workspace: `outcome` `ok` or a code. */
export async function logAction(input: LogInput): Promise<LoggedAction> {
  const { accountId, ...entry } = parseInput(logInput, input);
  const account = await findAccount(accountId);
  return writeLog(account.id, entry, now());
}

/** The row in the caller's run; the metric is the caller's, after its run (countAction). */
export async function writeLog(
  senderAccountId: string,
  { kind, objectRef, count, outcome, withNote = false, callRef }: ActionEntry,
  at: Date,
): Promise<LoggedAction> {
  const id = newId(ids.sender_action_log);
  const { workspaceId } = currentTenant();
  const row = { id, workspaceId, senderAccountId, kind, objectRef, count, outcome, withNote };
  await tenantClient.senderActionLog.create({ data: { ...row, callRef, at } });
  return { id, kind, count, outcome };
}

/** linkedin.actions, by kind and outcome, for a row whose run has committed. */
export function countAction({ kind, count, outcome }: LoggedAction): void {
  linkedinMetrics["linkedin.actions"].add(count, { kind, outcome });
}

/**
 * A port call's failure as the log records it: its code when the closed list has it; a failure
 * that is no AppError, linkedin_provider_error; any other code, linkedin_error_unmapped.
 */
export function outcomeOf(error: unknown): ActionOutcome {
  if (!isAppError(error)) return linkedinPort.errors.linkedin_provider_error;
  return isActionOutcome(error.code) ? error.code : "linkedin_error_unmapped";
}

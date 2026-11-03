// The action log (docs/concepts.md "Action log"): a row per reservation, per read and per status
// check of a sender account, with its count and outcome, written in the caller's tenant run. The
// object is a post URL or a person id (schemas/quota.ts isObjectRef); no log line and no metric
// label carries it.
import { tenantClient } from "@whytide/db";
import { currentTenant, newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { linkedinMetrics } from "../../metrics.ts";
import { type actionKinds, type LogInput, logInput } from "../../schemas/quota.ts";
import { findAccount } from "../accounts.ts";
import { now } from "../clock.ts";
import { parseInput } from "../input.ts";

export type ActionEntry = {
  readonly kind: (typeof actionKinds)[number];
  readonly objectRef?: string | undefined;
  readonly count: number;
  readonly outcome: string;
};

/** A read made, or a status check, on an account of the run's workspace: `outcome` is `ok` or a code. */
export async function logAction(input: LogInput): Promise<{ id: string }> {
  const { accountId, ...entry } = parseInput(logInput, input);
  const account = await findAccount(accountId);
  return writeLog(account.id, entry, now());
}

/** The row in the caller's run, then the metric, by kind and outcome. */
export async function writeLog(
  senderAccountId: string,
  { kind, objectRef, count, outcome }: ActionEntry,
  at: Date,
): Promise<{ id: string }> {
  const id = newId(ids.sender_action_log);
  const { workspaceId } = currentTenant();
  await tenantClient.senderActionLog.create({
    data: { id, workspaceId, senderAccountId, kind, objectRef, count, outcome, at },
  });
  linkedinMetrics["linkedin.actions"].add(count, { kind, outcome });
  return { id };
}

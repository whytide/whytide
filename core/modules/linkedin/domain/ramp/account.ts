// One account's ramp in the caller's tenant run (docs/flows.md "The daily job"): its row locked
// (SELECT … FOR UPDATE), so that two runs at once give one step; then, under the lock, the switches,
// the account and its committed sends of the quota days rampStep reads; the new targets and
// ramp_updated_on written. The day is the account's quota day at `at`, in its zone (platform's
// quotaDay). Reservations lock the day's usage row, never the account's, so this waits on no send.
import { tenantClient } from "@whytide/db";
import { currentTenant, quotaDay } from "@whytide/platform";
import { readControls } from "../controls/controls.ts";
import { quotaDayBefore } from "../quota/limits.ts";
import { RAMP_IDLE_DAYS } from "./constants.ts";
import { type RampChange, rampStep } from "./ramp.ts";

/** The workspace's sender accounts' ids, oldest first: the daily job ramps each in its own run. */
export async function accountIds(): Promise<string[]> {
  const rows = await tenantClient.senderAccount.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

/** The account's ramp at `at`, written: the change, or null when none (or no such account). */
export async function rampAccount(accountId: string, at: Date): Promise<RampChange | null> {
  if (!(await lockAccount(accountId))) return null;
  const account = await tenantClient.senderAccount.findFirstOrThrow({
    where: { id: accountId },
    select: {
      status: true,
      healthState: true,
      killSwitch: true,
      timeZone: true,
      inviteTarget: true,
      messageTarget: true,
      rampUpdatedOn: true,
    },
  });
  const controls = await readControls();
  const today = quotaDay(at, account.timeZone);
  const idleFrom = quotaDayBefore(today, RAMP_IDLE_DAYS);
  const select = { quotaDay: true, invitesCommitted: true, messagesCommitted: true } as const;
  const rows = await tenantClient.senderQuotaUsage.findMany({
    where: { senderAccountId: accountId, quotaDay: { gte: idleFrom, lte: today } },
    select,
  });
  // Rule 5 asks only whether a send of each type came after the last step: before the 14 days, the
  // first day of each is enough, so the read stays bounded however long ago the last step was.
  const { rampUpdatedOn } = account;
  if (rampUpdatedOn !== null && rampUpdatedOn < idleFrom) {
    const before = { gt: rampUpdatedOn, lt: idleFrom };
    for (const sent of [{ invitesCommitted: { gt: 0 } }, { messagesCommitted: { gt: 0 } }]) {
      const first = await tenantClient.senderQuotaUsage.findFirst({
        where: { senderAccountId: accountId, quotaDay: before, ...sent },
        select,
        orderBy: { quotaDay: "asc" },
      });
      if (first !== null) rows.push(first);
    }
  }
  const sends = rows.map((row) => ({
    quotaDay: row.quotaDay,
    invites: row.invitesCommitted,
    messages: row.messagesCommitted,
  }));
  const change = rampStep({ ...account, controls }, today, sends);
  if (change === null) return null;
  await tenantClient.senderAccount.update({ where: { id: accountId }, data: change });
  return change;
}

/** The account's row locked to the run's end, in the run's workspace only: whether it was found. */
async function lockAccount(accountId: string): Promise<boolean> {
  const locked = await tenantClient.$queryRaw<{ id: string }[]>`
    SELECT id FROM sender_accounts
    WHERE workspace_id = ${currentTenant().workspaceId} AND id = ${accountId}
    FOR UPDATE`;
  return locked.length > 0;
}

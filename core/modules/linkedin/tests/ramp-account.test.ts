// rampAccount on the database (beta-p1-080; docs/flows.md "The daily job"): the account's quota day
// in its zone; of the days before the 14 the idle check reads, only the first with a send of each
// type since the last step, which still raises that type's target; an account not found, no change.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { quotaDayBefore } from "../domain/quota/limits.ts";
import { rampAccount } from "../domain/ramp/account.ts";
import { ids } from "../ids.ts";
import { createConnectedAccount, openSending, useLinkedinClient } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
const principal = servicePrincipal("linkedin_test");
/** 00:30 UTC on Monday 16 November 2026: still Sunday the 15th in Los Angeles. */
const AT = new Date("2026-11-16T00:30:00Z");

async function account(timeZone: string, rampUpdatedOn: string) {
  const workspaceId = `wsp_ramp_${timeZone.length}${rampUpdatedOn.replaceAll("-", "")}`;
  const { id } = await createConnectedAccount(workspaceId, { timeZone });
  await app.senderAccount.update({ where: { id }, data: { rampUpdatedOn } });
  /** Sends committed on the quota day `days` before `today`. */
  const sent = (today: string, days: number, invites: number, messages: number) =>
    app.senderQuotaUsage.create({
      data: {
        id: newId(ids.sender_quota_usage),
        workspaceId,
        senderAccountId: id,
        quotaDay: quotaDayBefore(today, days),
        timeZone,
        invitesCommitted: invites,
        messagesCommitted: messages,
      },
    });
  const ramp = (accountId = id) =>
    withTenant({ workspaceId, principal }, () => rampAccount(accountId, AT), { client: app });
  return { sent, ramp };
}

test("last moved 20 quota days ago, a connection request committed 18 days ago and messages 3 days ago: both targets rise, on the account's own quota day", async () => {
  await openSending();
  const today = "2026-11-15"; // in Los Angeles
  const { sent, ramp } = await account("America/Los_Angeles", quotaDayBefore(today, 20));
  await sent(today, 19, 0, 0);
  await sent(today, 18, 1, 0);
  await sent(today, 17, 2, 0);
  await sent(today, 3, 0, 2);
  assert.deepEqual(await ramp(), { inviteTarget: 7, messageTarget: 15, rampUpdatedOn: today });
  assert.equal(await ramp(), null, "the repeat");
});

test("last moved 20 quota days ago, messages only before the 14 days and a connection request 2 days ago: both rise; messages only, 18 days ago: idle, no rise", async () => {
  await openSending();
  const today = "2026-11-16";
  const both = await account("UTC", quotaDayBefore(today, 20));
  await both.sent(today, 18, 0, 3);
  await both.sent(today, 2, 1, 0);
  assert.deepEqual(await both.ramp(), { inviteTarget: 7, messageTarget: 15, rampUpdatedOn: today });
  const idle = await account("Europe/Paris", quotaDayBefore(today, 21));
  await idle.sent(today, 18, 0, 3);
  assert.deepEqual(await idle.ramp(), { inviteTarget: 5, messageTarget: 10, rampUpdatedOn: today });
  assert.equal(await idle.ramp("sac_unknown"), null, "no such account");
});

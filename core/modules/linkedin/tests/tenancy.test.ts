// test:tenancy for linkedin's tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): an account made by the module's connect, read in a run of one
// workspace by the module's query, is that workspace's only; so are a day's usage, a reservation and
// an action-log row made by reserveReads and logAction, read in the run through the scoped client; an
// outreach row (beta-p0-060), read as lastInboundAt reads it; the raw lock, sweep and settle of the
// reservations, called in one workspace's run with another's ids, touch nothing of it (beta-p1-030);
// a workspace's stop (beta-p1-040), which another workspace never reads nor obeys; a health event
// (beta-p6-010), made by applyHealth, and its raw lock, which another workspace's run never takes;
// and the request's commands and queries go through the tenant client.
import assert from "node:assert/strict";
import test from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import {
  disconnect,
  listAccounts,
  requestRefresh,
  senderOf,
  startConnect,
  updateSettings,
} from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import {
  pauseAccount,
  readControls,
  setWorkspaceStop,
  unpauseAccount,
} from "../domain/controls/controls.ts";
import { DISCLOSURE_VERSION } from "../domain/disclosure/constants.ts";
import { acceptDisclosure } from "../domain/disclosure/disclosure.ts";
import { erasePerson } from "../domain/erase.ts";
import { applyHealth } from "../domain/health/apply.ts";
import { pauseOnThirdError } from "../domain/health/signals.ts";
import { lockDay } from "../domain/quota/days.ts";
import { lockUsage, settle, sweep } from "../domain/quota/holds.ts";
import {
  commitReads,
  readUsage,
  releaseReads,
  remainingToday,
  reserveReads,
} from "../domain/quota/reservations.ts";
import { accountIds, rampAccount } from "../domain/ramp/account.ts";
import { lastInboundAt } from "../domain/receiver/last-inbound.ts";
import { purgeActionLog } from "../domain/retention/purge.ts";
import { expireStale, staleDays } from "../domain/retention/stale-holds.ts";
import { findSendReservation, reservationsOfKey } from "../domain/send/readers.ts";
import { reserveSend } from "../domain/send/reserve.ts";
import { commitSend, releaseSend } from "../domain/send/settle.ts";
import {
  createConnectedAccount,
  createOutreach,
  openSending,
  useClock,
  useLinkedinClient,
} from "../testing/index.ts";

withTestDb();
const client = asRole("app");
useLinkedinClient(client);
const NOW = new Date("2026-10-22T10:00:00Z"); // a Thursday, inside the default hours in UTC
useClock(() => NOW);
const principal = servicePrincipal("linkedin_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

isolationTest("sender_accounts", {
  async createRow(workspaceId) {
    const returnTo = `http://127.0.0.1:3000/w/${workspaceId}/linkedin`;
    const disclosure = { disclosureVersion: DISCLOSURE_VERSION, personalAccount: true };
    const input = { timeZone: "Europe/Paris", acknowledged: true, ...disclosure, returnTo };
    await startConnect({ workspaceId, principal }, input);
    const [account] = await inRun(workspaceId, () => listAccounts());
    if (!account) throw new Error("connect left no account");
    return account;
  },
  readAs: (workspaceId) => inRun(workspaceId, () => listAccounts()),
});

/** A reservation of one read on a new connected account of the workspace. */
async function reserveOne(workspaceId: string): Promise<{ id: string }> {
  const { id: accountId } = await createConnectedAccount(workspaceId);
  const answer = await inRun(workspaceId, () =>
    reserveReads({ accountId, count: 1, kind: "read_profile" }),
  );
  if (!("reservationId" in answer)) throw new Error(`refused: ${answer.refused}`);
  return { id: answer.reservationId };
}

isolationTest("sender_quota_usage", {
  async createRow(workspaceId) {
    await reserveOne(workspaceId);
    return inRun(workspaceId, () => tenantClient.senderQuotaUsage.findFirstOrThrow());
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.senderQuotaUsage.findMany()),
});

isolationTest("sender_quota_reservations", {
  createRow: reserveOne,
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.senderQuotaReservation.findMany()),
});

isolationTest("sender_action_log", {
  async createRow(workspaceId) {
    const { id: accountId } = await createConnectedAccount(workspaceId);
    const read = { accountId, kind: "read_profile", count: 1, outcome: "ok" } as const;
    return inRun(workspaceId, () => logAction(read));
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.senderActionLog.findMany()),
});

isolationTest("sender_outreach", {
  async createRow(workspaceId) {
    const { id: senderAccountId } = await createConnectedAccount(workspaceId);
    return createOutreach(workspaceId, { senderAccountId, providerMemberRef: "member-1" });
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.senderOutreach.findMany()),
});

isolationTest("linkedin_workspace_controls", {
  async createRow(workspaceId) {
    await inRun(workspaceId, () => setWorkspaceStop(true, "usr_tenancy"));
    return inRun(workspaceId, () => tenantClient.linkedinWorkspaceControl.findFirstOrThrow());
  },
  readAs: (workspaceId) =>
    inRun(workspaceId, () => tenantClient.linkedinWorkspaceControl.findMany()),
});

isolationTest("sender_health_events", {
  async createRow(workspaceId) {
    const { id } = await createConnectedAccount(workspaceId);
    const cause = { at: NOW, trigger: "limit_reached" } as const;
    await inRun(workspaceId, () => applyHealth(tenantClient, id, "restricted", cause));
    return inRun(workspaceId, () => tenantClient.senderHealthEvent.findFirstOrThrow());
  },
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.senderHealthEvent.findMany()),
});

test("applyHealth's raw lock, called in workspace B's run with workspace A's account, finds and changes nothing of A; the third error's count goes through the tenant client", async () => {
  const { id } = await createConnectedAccount("wsp_tenancy_health_a");
  const where = { id };
  const before = await client.senderAccount.findUniqueOrThrow({ where });
  const cause = { at: NOW, trigger: "checkpoint" } as const;
  const inB = await inRun("wsp_tenancy_health_b", () =>
    applyHealth(tenantClient, id, "checkpoint", cause),
  );
  assert.equal(inB, null);
  assert.deepEqual(await client.senderAccount.findUniqueOrThrow({ where }), before);
  assert.equal(await client.senderHealthEvent.count(), 0);
  await assertScoped(() => applyHealth(tenantClient, "sac_unknown", "checkpoint", cause));
  await assertScoped(() => pauseOnThirdError("sac_unknown", NOW));
});

test("a workspace's stop holds in that workspace only: the other reads no stop and still reserves a read", async () => {
  const [a, b] = ["wsp_tenancy_stop_a", "wsp_tenancy_stop_b"];
  const { id: accountId } = await createConnectedAccount(b);
  await inRun(a, () => setWorkspaceStop(true, "usr_tenancy"));
  assert.deepEqual((await inRun(a, () => readControls())).workspace, {
    stopped: true,
    stopSource: "tester",
  });
  assert.deepEqual((await inRun(b, () => readControls())).workspace, {
    stopped: false,
    stopSource: null,
  });
  const read = await inRun(b, () => reserveReads({ accountId, count: 1, kind: "read_profile" }));
  assert.ok("reservationId" in read, `refused: ${JSON.stringify(read)}`);
});

test("the raw lock, sweep and settle statements, called in workspace B's run with workspace A's ids, lock, sweep and settle nothing of A (alpha security, L37)", async () => {
  const [a, b] = ["wsp_tenancy_raw_a", "wsp_tenancy_raw_b"];
  const { id: accountId } = await createConnectedAccount(a);
  await openSending();
  const input = { accountId, actionType: "invite", idempotencyKey: "key-raw" } as const;
  const answer = await inRun(a, () => reserveSend(input));
  assert.ok("reservationId" in answer);
  const where = { id: answer.reservationId };
  // Past its hold, as a sweep would find it.
  const held = await client.senderQuotaReservation.update({ where, data: { expiresAt: NOW } });
  const day = await client.senderQuotaUsage.findUniqueOrThrow({ where: { id: held.usageId } });
  const inB = await inRun(b, async () => ({
    day: await lockDay(accountId, day.quotaDay),
    usage: await lockUsage(day.id),
    swept: await sweep(day, NOW),
  }));
  assert.deepEqual(inB, { day: null, usage: false, swept: day });
  await assert.rejects(inRun(b, () => settle(held, "released", 0)));
  const after = await client.senderQuotaReservation.findUniqueOrThrow({ where });
  assert.deepEqual([after.status, after.settledAt], ["reserved", null]);
  assert.deepEqual(await client.senderQuotaUsage.findUniqueOrThrow({ where: { id: day.id } }), day);
  // In A's own run the same statements find the row.
  assert.equal((await inRun(a, () => sweep(day, NOW))).invitesReserved, 0);
});

test("the daily job's raw lock of an account, called in workspace B's run with workspace A's account, locks and ramps nothing of A; its queries and the action log's purge go through the tenant client (beta-p1-080)", async () => {
  const { id } = await createConnectedAccount("wsp_tenancy_ramp_a");
  await openSending();
  const where = { id };
  const before = await client.senderAccount.findUniqueOrThrow({ where });
  assert.equal(await inRun("wsp_tenancy_ramp_b", () => rampAccount(id, NOW)), null);
  assert.deepEqual(await client.senderAccount.findUniqueOrThrow({ where }), before);
  // In A's own run the same statement finds the account, due its first day.
  assert.notEqual(await inRun("wsp_tenancy_ramp_a", () => rampAccount(id, NOW)), null);
  await assertScoped(() => accountIds());
  await assertScoped(() => rampAccount("sac_unknown", NOW));
  await assertScoped(() => staleDays(NOW));
  await assertScoped(() => expireStale("squ_unknown", NOW));
  await assertScoped(() => purgeActionLog((fn) => fn(), NOW));
});

test("every query and command of a request or a run on linkedin's tables goes through the tenant client", async () => {
  await assertScoped(() => listAccounts());
  await assertScoped(() => updateSettings("sac_unknown", { label: "Mine" }));
  await assertScoped(() => disconnect("sac_unknown"));
  await assertScoped(() => requestRefresh("sac_unknown"));
  await assertScoped(() =>
    reserveReads({ accountId: "sac_unknown", count: 1, kind: "read_profile" }),
  );
  await assertScoped(() => commitReads("sqr_unknown", 1));
  await assertScoped(() => releaseReads("sqr_unknown"));
  await assertScoped(() => readUsage("sac_unknown"));
  await assertScoped(() => remainingToday("sac_unknown"));
  await assertScoped(() => senderOf("usr_unknown"));
  const read = { accountId: "sac_unknown", kind: "status_check", count: 1, outcome: "ok" } as const;
  await assertScoped(() => logAction(read));
  await assertScoped(() => lastInboundAt("sac_unknown", "per_unknown"));
  await assertScoped(() => erasePerson("per_unknown"));
  const send = { accountId: "sac_unknown", actionType: "invite", idempotencyKey: "key" } as const;
  await assertScoped(() => reserveSend(send));
  await assertScoped(() => commitSend("sqr_unknown"));
  await assertScoped(() => releaseSend("sqr_unknown"));
  await assertScoped(() => findSendReservation("sqr_unknown"));
  await assertScoped(() => reservationsOfKey("key"));
  await assertScoped(() => readControls());
  await assertScoped(() => pauseAccount("sac_unknown", "usr_unknown"));
  await assertScoped(() => unpauseAccount("sac_unknown", "usr_unknown"));
  await assertScoped(() => setWorkspaceStop(true, "usr_unknown"));
  const accepted = { version: DISCLOSURE_VERSION, personalAccount: true };
  await assertScoped(() => acceptDisclosure("sac_unknown", "usr_unknown", accepted));
});

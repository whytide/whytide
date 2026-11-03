// test:tenancy for linkedin's tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): an account made by the module's connect, read in a run of one
// workspace by the module's query, is that workspace's only; so are a day's usage, a reservation and
// an action-log row made by reserveReads and logAction, read in the run through the scoped client;
// and the request's commands and queries go through the tenant client.
import test from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import {
  disconnect,
  listAccounts,
  requestRefresh,
  startConnect,
  updateSettings,
} from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import {
  commitReads,
  readUsage,
  releaseReads,
  reserveReads,
} from "../domain/quota/reservations.ts";
import { createConnectedAccount, useClock, useLinkedinClient } from "../testing/index.ts";

withTestDb();
const client = asRole("app");
useLinkedinClient(client);
useClock(() => new Date("2026-10-22T10:00:00Z")); // a Thursday, inside the default hours in UTC
const principal = servicePrincipal("linkedin_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

isolationTest("sender_accounts", {
  async createRow(workspaceId) {
    const returnTo = `http://127.0.0.1:3000/w/${workspaceId}/linkedin`;
    const input = { timeZone: "Europe/Paris", acknowledged: true, returnTo };
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
  const read = { accountId: "sac_unknown", kind: "status_check", count: 1, outcome: "ok" } as const;
  await assertScoped(() => logAction(read));
});

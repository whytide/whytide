// The action log's rules (beta-p1-030; docs/security.md "Action log"), in this file's schema of the
// worktree's database: app cannot update a row (42501) and still deletes one through linkedin's
// erasePerson; the database refuses an outcome off ACTION_OUTCOMES, whose list equals the CHECK; a
// send's row names its step execution, never a person or a profile; and linkedin.actions is added
// after an activity's run has returned, so a run that rolls back adds nothing.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import {
  loadMasterKeys,
  newId,
  newMasterKey,
  recordedMetrics,
  servicePrincipal,
} from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { logAction } from "../domain/action-log/log.ts";
import { erasePerson } from "../domain/erase.ts";
import { ids } from "../ids.ts";
import { ACTION_OUTCOMES, type LogInput } from "../schemas/quota.ts";
import { createConnectedAccount, useLinkedinClient, useSecretKeys } from "../testing/index.ts";
import { refreshStatus } from "../workflows/index.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
useTenancyClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const principal = servicePrincipal("linkedin_test");
const PERSON = "per_01JABCDEFGHJKMNPQRSTVWXYZ0";
const STEP = "sx_01JABCDEFGHJKMNPQRSTVWXYZ0";
type Tx = Parameters<Parameters<typeof withTenant>[1]>[0];

/** A connected account of a new workspace, a run in it, and its log calls. */
async function account(providerAccountRef?: string) {
  const { workspace } = await createOrganizationWithWorkspace();
  const { id } = await createConnectedAccount(workspace.id, { providerAccountRef });
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant({ workspaceId: workspace.id, principal }, fn, { client: app });
  const log = (entry: Omit<LogInput, "accountId">) =>
    run(() => logAction({ accountId: id, ...entry }));
  return { id, workspaceId: workspace.id, run, log };
}

test("app cannot update an action-log row (42501), and still deletes one through linkedin's erasePerson", async () => {
  const { id, run, log } = await account();
  await log({ kind: "read_profile", objectRef: PERSON, count: 1, outcome: "ok" });
  const update = app.$executeRaw`UPDATE sender_action_log SET count = 2 WHERE sender_account_id = ${id}`;
  assert.equal(await sqlstate(update), "42501");
  assert.deepEqual(await run(() => erasePerson(PERSON)), {
    sender_outreach: 0,
    sender_action_log: 1,
  });
});

test("the outcome CHECK holds exactly ACTION_OUTCOMES, and the database refuses an outcome off it", async () => {
  const { id, workspaceId } = await account();
  const [check] = await app.$queryRaw<{ definition: string }[]>`
    SELECT pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = 'sender_action_log_outcome_known' AND n.nspname = current_schema()`;
  const listed = [...(check?.definition ?? "").matchAll(/'(\w+)'::text/g)].map(
    ([, value]) => value,
  );
  assert.deepEqual(listed.sort(), [...ACTION_OUTCOMES].sort());
  const row = {
    id: newId(ids.sender_action_log),
    workspaceId,
    senderAccountId: id,
    kind: "invite" as const,
    count: 1,
    at: new Date(),
  };
  assert.equal(
    await sqlstate(app.senderActionLog.create({ data: { ...row, outcome: "sent" } })),
    "23514",
  );
  assert.equal(
    await sqlstate(app.senderActionLog.create({ data: { ...row, outcome: "ok" } })),
    undefined,
  );
});

test("a send's row names its step execution, with its note on an invite; a profile URL, a person's id on a send and a note off an invite are refused", async () => {
  const { id, log } = await account();
  await log({ kind: "invite", objectRef: STEP, count: 1, outcome: "ok", withNote: true });
  const refused = (fields: string[]) => ({ code: "read_input_invalid", details: { fields } });
  const profile = "https://www.linkedin.com/in/someone";
  const send = { kind: "invite", count: 1, outcome: "ok" } as const;
  await assert.rejects(log({ ...send, objectRef: profile }), refused(["objectRef"]));
  await assert.rejects(
    log({ ...send, kind: "message", objectRef: PERSON }),
    refused(["objectRef"]),
  );
  const read = { kind: "read_profile", count: 1, outcome: "ok", withNote: true } as const;
  await assert.rejects(log(read), refused(["withNote"]));
  const rows = await app.senderActionLog.findMany({ where: { senderAccountId: id } });
  assert.deepEqual(
    rows.map(({ kind, objectRef, withNote }) => [kind, objectRef, withNote]),
    [["invite", STEP, true]],
  );
});

test("linkedin.actions is added after the activity's run: a status check whose log run rolls back adds nothing, nor a row; the next adds its own", async () => {
  const { id, workspaceId } = await account("fake-account-gone"); // the fake knows it not: disconnected
  let rollBack = true;
  const context = {
    workspaceId,
    tenant: <T>(fn: (tx: Tx) => Promise<T>) =>
      withTenant(
        { workspaceId, principal },
        async (tx) => {
          const result = await fn(tx);
          // The log's run fails once its row is written: its transaction rolls back.
          const row = result as { id?: unknown } | null;
          if (rollBack && String(row?.id).startsWith("sal_")) throw new Error("the run rolls back");
          return result;
        },
        { client: app },
      ),
  };
  const counted = () =>
    (recordedMetrics().get("linkedin.actions") ?? []).filter((set) => set.kind === "status_check");
  await assert.rejects(refreshStatus(context, id), /the run rolls back/);
  assert.deepEqual(counted(), []);
  assert.equal(await app.senderActionLog.count({ where: { senderAccountId: id } }), 0);
  rollBack = false;
  assert.deepEqual(await refreshStatus(context, id), { status: "disconnected" });
  assert.deepEqual(counted(), [{ kind: "status_check", outcome: "disconnected" }]);
});

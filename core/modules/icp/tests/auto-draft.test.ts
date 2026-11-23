// The automatic draft's trigger (icp-auto-draft; README "The automatic draft") on the worktree's
// database: onboarding.company_knowledge_updated, published as onboarding's save leaves it and
// delivered by the platform's runner as the worker delivers it, requests one automatic draft of the
// empty default, and nothing otherwise. The run's own save is the worker's tests/icp-draft.test.ts,
// on the LLM fake.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createOutboxStore, outboxWriter, type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { events as onboarding } from "@whytide/onboarding";
import {
  bindWorkflowStarter,
  collectLogs,
  createLogger,
  deliverPending,
  publish,
  servicePrincipal,
  type WorkflowStart,
} from "@whytide/platform";
import { draftAutomatically } from "../domain/auto-draft.ts";
import { createAudience, getIcp } from "../domain/commands.ts";
import { draftStart } from "../events.ts";
import { together } from "./together.ts";

withTestDb();
const principal = servicePrincipal("worker");
const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
const log = createLogger({ destination: collectLogs().destination });

/** The workflows the deliveries started, as the worker's starter would. */
const starts: WorkflowStart[] = [];
let unbind = () => {};
before(() => {
  unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
});
after(() => unbind());

const A = "wsp_auto_a";
const B = "wsp_auto_b";
const KNOWLEDGE = { oneLiner: "Bookkeeping for bakeries", products: ["Ledger"] };
/** No content field: the website and the tone are not what the drafter reads. */
const NO_CONTENT = { sourceUrl: "https://ledger.example/", tone: "Plain" };

/** The workspace's Company Knowledge record, as onboarding stores it. */
const knowledge = (workspaceId: string, fields: object = KNOWLEDGE) =>
  run(workspaceId, (tx) =>
    tx.companyKnowledge.create({ data: { id: `ck_${workspaceId}`, workspaceId, ...fields } }),
  );
/** A save of the Company Knowledge: its event in the outbox, as onboarding writes it. */
const updated = (workspaceId: string, version = 2) =>
  run(workspaceId, (tx) =>
    publish(outboxWriter(tx, workspaceId), onboarding["onboarding.company_knowledge_updated"], {
      workspaceId,
      version,
    }),
  );
/** One pass of the worker's delivery, each handler in a tenant run of the event's workspace. */
async function deliver(): Promise<void> {
  const report = await deliverPending({
    store: createOutboxStore(asRole("app")),
    runInTenant: (workspaceId, fn) => run(workspaceId, fn),
    log,
  });
  assert.equal(report.delivered, report.claimed, JSON.stringify(report));
}
const defaultOf = (workspaceId: string) =>
  run(workspaceId, (tx) => tx.icp.findFirst({ where: { isDefault: true } }));
const requests = (workspaceId: string) =>
  run(workspaceId, (tx) =>
    tx.outboxEntry.findMany({ where: { eventName: "icp.draft_requested" } }),
  );
/** The default's draft columns, and its version. */
const draftOf = async (workspaceId: string) => {
  const icp = await defaultOf(workspaceId);
  return icp && [icp.draftStatus, icp.draftAutomatic, icp.draftRunId, icp.version];
};
/** Sets the default's columns: its targeting, or its draft as a run leaves it. */
const setDefault = (workspaceId: string, data: object) =>
  run(workspaceId, (tx) => tx.icp.updateMany({ where: { isDefault: true }, data }));

test("Company Knowledge with a content field and an empty ICP: the delivery requests the automatic draft of the default, no brief, which starts its workflow; another audience and another workspace's ICP untouched", async () => {
  starts.length = 0;
  await Promise.all([knowledge(A), knowledge(B)]);
  const other = await run(A, () => createAudience({ name: "Bakeries", createdBy: "usr_a" }));
  await run(B, () => getIcp(B));
  const bBefore = await run(B, (tx) => tx.icp.findMany({}));

  await updated(A);
  await deliver();
  const icp = await defaultOf(A);
  assert.ok(icp?.draftRunId);
  assert.deepEqual(
    [icp.draftStatus, icp.draftAutomatic, icp.draftBrief, icp.pendingDraft, icp.version],
    ["drafting", true, "", null, 1],
  );
  const ids = { workspaceId: A, icpId: icp.id, draftRunId: icp.draftRunId };
  assert.deepEqual(
    (await requests(A)).map((entry) => entry.payload),
    [ids],
  );
  const audience = await run(A, (tx) => tx.icp.findFirstOrThrow({ where: { id: other.id } }));
  assert.deepEqual([audience.draftStatus, audience.draftRunId], ["none", null]);
  const outbox = (eventName: string) =>
    run(A, (tx) => tx.outboxEntry.count({ where: { eventName } }));
  assert.deepEqual([await outbox("icp.updated"), await outbox("icp.audience_updated")], [0, 0]);

  await deliver();
  assert.deepEqual(starts, [draftStart(ids)]);
  assert.deepEqual(await run(B, (tx) => tx.icp.findMany({})), bBefore);
  assert.deepEqual(await requests(B), []);
});

test("nothing while the Company Knowledge has no content field: no draft, and no ICP made", async () => {
  await knowledge(A, NO_CONTENT);
  await updated(A);
  await deliver();
  assert.equal(await defaultOf(A), null);
  assert.deepEqual(await requests(A), []);
});

test("nothing over an ICP with targeting, nor while a draft is drafting or drafted; a failed draft is tried again while the ICP is empty", async () => {
  await knowledge(A);
  const deliverOne = async () => {
    await updated(A);
    await deliver();
  };
  await run(A, () => getIcp(A));

  await setDefault(A, { titles: ["Owner"] });
  await deliverOne();
  assert.deepEqual(await draftOf(A), ["none", false, null, 1]);
  await setDefault(A, { titles: [], mustHaves: "Two shops or more" });
  await deliverOne();
  assert.deepEqual(await draftOf(A), ["none", false, null, 1]);

  await setDefault(A, { mustHaves: "" });
  for (const draftStatus of ["drafting", "drafted"]) {
    await setDefault(A, { draftStatus, draftRunId: "idrun_member" });
    await deliverOne();
    assert.deepEqual(await draftOf(A), [draftStatus, false, "idrun_member", 1]);
  }
  assert.deepEqual(await requests(A), []);

  await setDefault(A, {
    draftStatus: "failed",
    draftError: "ai_failed",
    draftRunId: "idrun_failed",
  });
  await deliverOne();
  const [status, automatic, draftRunId] = (await draftOf(A)) ?? [];
  assert.deepEqual([status, automatic], ["drafting", true]);
  assert.notEqual(draftRunId, "idrun_failed");
  assert.equal((await requests(A)).length, 1);
});

test("one draft for a burst of saves, a later delivery and two deliveries at once; the first delivery makes the default", async () => {
  await knowledge(A);
  assert.equal(await defaultOf(A), null);
  await updated(A, 2);
  await updated(A, 3);
  await deliver();
  const first = await draftOf(A);
  assert.equal(first?.[0], "drafting");
  await updated(A, 4);
  await deliver();
  assert.deepEqual(await draftOf(A), first);
  assert.equal((await requests(A)).length, 1);

  // Two deliveries at once, both in their transactions before either reads: the row lock orders them.
  await knowledge(B);
  await run(B, () => getIcp(B));
  const met = together(2);
  const racing = () =>
    run(B, async () => {
      await met();
      return draftAutomatically();
    });
  const runs = await Promise.all([racing(), racing()]);
  assert.equal(runs.filter((id) => id !== null).length, 1, JSON.stringify(runs));
  assert.equal((await requests(B)).length, 1);
});

// The safety cases of enrolling (beta-p2-040; docs/security.md), run by `pnpm -F campaigns
// test:safety` and not by `test`, on the worktree's database in this file's schema, through the
// outbox as the worker delivers it: a person who opted out or was touched in the last 90 days gets no
// step execution; a block committed while the delivery waits on the lead's lock leaves no step
// (beta-p2-050); a person never has two active enrollments, whether two approvals are delivered one
// after the other or at once, and the database refuses a second active row; a redelivered event
// enrolls once; every new step is planned; and the partial unique key refuses a second row with one
// key entering executing, while two unsent rows with that key stand.
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  addOptOut,
  events as contacts,
  createLeadForPerson,
  recordLeadStatus,
  recordTouch,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { createOutboxStore, outboxWriter, type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import {
  collectLogs,
  createLogger,
  deliverPending,
  newId,
  publish,
  servicePrincipal,
} from "@whytide/platform";
import { enrollApproved } from "../../domain/enroll/enroll.ts";
import "../../events.ts";
import { ids } from "../../ids.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_safety";
const DAY_MS = 86_400_000;
const app = () => asRole("app");
/** The approver's account, the approver the workspace's Owner: the seeded campaign's sender. */
const { account } = fixture(WORKSPACE);
const log = createLogger({ destination: collectLogs().destination });
const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal: servicePrincipal("campaigns_safety") }, fn, {
    client: app(),
  });

/** A person of the workspace with a lead, through contacts' commands; its id. */
const leadOf = (slug: string) =>
  run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
/** The lead approved, as Approve leaves it (contacts' approveLead is its route's only). */
const approved = (personId: string) =>
  recordLeadStatus(personId, "approved", { actor: { type: "user", id: APPROVER } });
/** Approve: the lead approved and the event it publishes, in the outbox, in one run. */
const approve = (personId: string) =>
  run(async (tx) => {
    await approved(personId);
    return publish(outboxWriter(tx, WORKSPACE), contacts["contacts.lead_approved"], {
      personId,
      approvedBy: APPROVER,
    });
  });
/**
 * One pass of the worker's delivery, each handler in a tenant run of the event's workspace, in which
 * every event claimed is delivered, none retried: the count.
 */
async function deliver(): Promise<number> {
  const report = await deliverPending({
    store: createOutboxStore(app()),
    runInTenant: (workspaceId, fn) =>
      withTenant({ workspaceId, principal: servicePrincipal("worker") }, fn, { client: app() }),
    log,
  });
  const { claimed, delivered, ...failed } = report;
  assert.deepEqual([delivered, failed], [claimed, { retried: 0, dead: 0, deferred: 0 }]);
  return delivered;
}
/** Whether a run of this role waits on a lock taken by a read of a lead for update. */
const waitingOnLead = async () => {
  const [row] = await app().$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting FROM pg_stat_activity
    WHERE datname = current_database() AND wait_event_type = 'Lock'
      AND query LIKE '%FROM leads%FOR UPDATE%'`;
  return (row?.waiting ?? 0) > 0;
};
const enrollmentsOf = (personId: string) =>
  app().enrollment.findMany({ where: { personId }, orderBy: { createdAt: "asc" } });
const stepsOf = (personId: string) =>
  app().stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } });
/** A write the named unique index refuses: Prisma's P2002, Postgres' unique_violation. */
const refusedBy = (write: Promise<unknown>, index: string) =>
  assert.rejects(write, { code: "P2002", message: new RegExp(`\`${index}\``) });

test("a person who opted out, or was touched in the last 90 days, gets an exited enrollment and no step execution", async () => {
  await account();
  const optedOut = await leadOf("safety-opted-out");
  const touched = await leadOf("safety-touched");
  const clear = await leadOf("safety-clear");
  for (const personId of [optedOut, touched, clear]) await approve(personId);
  // Between Approve and the delivery.
  await run(async () => {
    await addOptOut(optedOut, { source: "system", reason: "reply_opt_out" });
    await recordTouch(touched, new Date(Date.now() - 89 * DAY_MS));
  });
  // The three approvals, and the opt-out's own event, which meets no active enrollment.
  assert.equal(await deliver(), 4);

  // The control: the same delivery enrolls a person the check allows.
  assert.equal((await stepsOf(clear)).length, 4);
  for (const [personId, reason] of [
    [optedOut, "opted_out"],
    [touched, "recently_contacted"],
  ] as const) {
    const enrollments = await enrollmentsOf(personId);
    const seen = enrollments.map(({ status, exitReason, exitDetail, endedAt }) => ({
      status,
      exitReason,
      exitDetail,
      ended: endedAt !== null,
    }));
    assert.deepEqual(seen, [
      { status: "exited", exitReason: "suppressed", ...{ exitDetail: reason, ended: true } },
    ]);
    assert.deepEqual(await stepsOf(personId), [], `${reason}: no step execution`);
  }
});

test("a block committed while the delivery waits on the lead leaves no step, and the lead suppressed", async () => {
  await account();
  const personId = await leadOf("safety-raced");
  await approve(personId);
  // The block's run writes its entry and locks the lead (contacts' suppression write), then waits.
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let blocked = () => {};
  const lockHeld = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const block = run(async () => {
    await addOptOut(personId, { source: "system", reason: "reply_opt_out" });
    blocked();
    await released;
  });
  await lockHeld;
  const delivery = deliver();
  // The delivery waits on the lead's row: the block has not committed, its entry unseen.
  for (let waits = 0; !(await waitingOnLead()); waits++) {
    assert.ok(waits < 200, "the delivery never waited on the lead");
    await sleep(25);
  }
  release();
  await block;
  assert.equal(await delivery, 1);
  const seen = (await enrollmentsOf(personId)).map(({ status, exitReason, exitDetail }) => ({
    ...{ status, exitReason, exitDetail },
  }));
  assert.deepEqual(seen, [{ status: "exited", exitReason: "suppressed", exitDetail: "opted_out" }]);
  assert.deepEqual(await stepsOf(personId), []);
  const lead = await app().lead.findFirstOrThrow({ where: { personId } });
  assert.equal(lead.outreachStatus, "suppressed");
  // The opt-out's own event, delivered next, meets no active enrollment.
  assert.equal(await deliver(), 1);
});

test("a person never has two active enrollments: two approvals one after the other, two deliveries at once, or a direct write", async () => {
  await account();
  const twice = await leadOf("safety-twice");
  await approve(twice);
  await approve(twice);
  assert.equal(await deliver(), 2);
  assert.deepEqual(
    (await enrollmentsOf(twice)).map(({ status }) => status),
    ["active"],
  );
  assert.equal((await stepsOf(twice)).length, 4);

  // Two events of one person delivered at once, each in its own transaction.
  const atOnce = await leadOf("safety-at-once");
  await run(() => approved(atOnce));
  const delivery = () =>
    run((tx) =>
      enrollApproved(tx, { sourceEventId: newId("obx"), personId: atOnce, approvedBy: APPROVER }),
    );
  const outcomes = await Promise.all([delivery(), delivery()]);
  assert.deepEqual(outcomes.sort(), ["enrolled", "enrolled_already"]);
  const [active, ...others] = await enrollmentsOf(atOnce);
  assert.ok(active);
  assert.deepEqual([active.status, others], ["active", []]);
  assert.equal((await stepsOf(atOnce)).length, 4);

  // The database itself refuses a second active enrollment of the person, whoever writes it.
  const second = { ...active, id: newId(ids.enrollment), sourceEventId: newId("obx") };
  await refusedBy(app().enrollment.create({ data: second }), "enrollments_active_person");
});

test("a redelivered event enrolls once, and every new step is planned", async () => {
  await account();
  const personId = await leadOf("safety-redelivered");
  const eventId = await approve(personId);
  assert.equal(await deliver(), 1);
  const before = { enrollments: await enrollmentsOf(personId), steps: await stepsOf(personId) };
  const changes = () =>
    app().leadStatusChange.count({ where: { personId, toStatus: "in_campaign" } });
  assert.equal(await changes(), 1);

  // A crash between the handler's commit and the row's mark leaves the event due again.
  const due = { deliveredAt: null, nextAttemptAt: new Date(0) };
  await app().outboxEntry.update({ where: { id: eventId }, data: due });
  assert.equal(await deliver(), 1);
  assert.deepEqual(await enrollmentsOf(personId), before.enrollments);
  assert.deepEqual(await stepsOf(personId), before.steps);
  assert.equal(await changes(), 1, "one change to in_campaign");
  assert.deepEqual(
    before.steps.map(({ status }) => status),
    ["planned", "planned", "planned", "planned"],
  );
});

test("the partial unique key: two unsent rows with one key stand, a second one entering executing is refused", async () => {
  await account();
  const personId = await leadOf("safety-key");
  await approve(personId);
  assert.equal(await deliver(), 1);
  // The person exits with nothing sent, and is enrolled again: the same steps, the same keys.
  const [first] = await enrollmentsOf(personId);
  assert.ok(first);
  const exited = { status: "exited", exitReason: "removed", endedAt: new Date() } as const;
  await app().enrollment.update({ where: { id: first.id }, data: exited });
  await approve(personId);
  assert.equal(await deliver(), 1);
  const steps = await stepsOf(personId);
  const connects = steps.filter(({ stepKey }) => stepKey === "connect");
  assert.equal(connects.length, 2);
  const [a, b] = connects as [(typeof connects)[number], (typeof connects)[number]];
  assert.equal(a.idempotencyKey, b.idempotencyKey);

  const move = (id: string, status: "executing" | "succeeded" | "failed") =>
    app().stepExecution.update({ where: { id }, data: { status } });
  const claimed = "step_executions_key_claimed";
  await move(a.id, "executing");
  await refusedBy(move(b.id, "executing"), claimed);
  await move(a.id, "succeeded");
  await refusedBy(move(b.id, "executing"), claimed);
  await refusedBy(move(b.id, "succeeded"), claimed);
  // A row that failed frees the key for the next claim.
  await move(a.id, "failed");
  await move(b.id, "executing");
});

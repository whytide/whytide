// Safety case, send path (beta-p5-010; core/modules/inbox/README.md "The store"; F12 §11 "Any reply
// stops the sequence for that person"), end to end on the fakes, on the slice's Temporal and a schema
// of its database: the host started with campaigns and inbox from their builds, as the worker loads
// them. A person approved and enrolled through the outbox, the connection request sent, the next steps
// scheduled, awaiting approval and planned; the person's reply through linkedin's receiver (the
// LinkedIn fake's webhook, handed on as the route does before its 204): every pending step held
// within 60 seconds. The same event twice, from the vendor and from the outbox: one message, one
// inbox.reply_received, one run. A "remove me" reply: the person's opt-out. It lives here: a module
// never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, Connection } from "@temporalio/client";
import type { TenantClient } from "@whytide/db";
import type { Principal } from "@whytide/platform";
import type { LinkedinFake } from "@whytide/providers";

// The fakes, whatever the environment names: nothing here calls a provider or a model, nor may.
process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, linkedinPort } = await import("@whytide/providers");
const { workerConfig } = await import("../../src/config.ts");
const { moduleLoaders } = await import("../../src/modules.generated.ts");
const { start } = await import("../../src/start.ts");
const built = (file: string) => new URL(`../../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const { handleWebhook } = await import(built("linkedin/dist/domain/status.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
linkedin.useHashKey("test-key-".repeat(4)); // the receipts' keyed hash (beta-p1-070), never a real key
tenancy.useTenancyClient(app);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const log = platform.createLogger({ destination: platform.collectLogs().destination });

const APPROVER = "usr_inbox_approver";
const MEMBER = "member-noor";
const STOP_WITHIN_MS = 60_000;
const approver: Principal = {
  userId: APPROVER,
  actorType: "human",
  authMethod: "session",
  scopes: [],
};

/** The first truthy answer of `probe`, asked every 50 ms for 60 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + STOP_WITHIN_MS;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 60 seconds");
    await sleep(50);
  }
}

/**
 * A workspace whose approver, its Owner, has an account the fake knows, so the seeded campaign sends
 * from it (gamma-p6-040), and a person approved by the member and enrolled by campaigns' subscriber
 * through the host's outbox, with an outreach row on the account, the connection request sent and
 * the next steps scheduled, awaiting approval and planned.
 */
async function enrolledReply() {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const user = { id: APPROVER, email: `${APPROVER}@example.com` };
  await app.user.upsert({ where: { id: APPROVER }, create: user, update: {} });
  await tenancy.createMembership({ userId: APPROVER, workspaceId, role: "Owner" });
  const ref = `fake-account-${randomUUID()}`;
  const account = { ownerUserId: APPROVER, providerAccountRef: ref };
  const { id: senderAccountId } = await linkedin.createConnectedAccount(workspaceId, account);
  const inRun = <T>(principal: Principal, fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const personId: string = await inRun(platform.servicePrincipal("inbox_test"), async () => {
    const profile = { linkedinUrl: "https://linkedin.com/in/noor-reply", firstName: "Noor" };
    const source = { source: "import", provider: "csv", profile };
    const { person } = await contacts.upsertPersonFromSource(source);
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    return person.id;
  });
  await inRun(approver, () => approveLead(personId));
  const steps = await until(async () => {
    const rows = await app.stepExecution.findMany({ where: { personId } });
    return rows.length === 4 ? rows : null;
  });
  const moved = {
    connect: "succeeded",
    message_1: "scheduled",
    follow_up_1: "awaiting_approval",
  } as const;
  for (const { id, stepKey } of steps) {
    const status = moved[stepKey as keyof typeof moved];
    if (status) await app.stepExecution.update({ where: { id }, data: { status } });
  }
  await linkedin.createOutreach(workspaceId, {
    senderAccountId,
    personId,
    providerMemberRef: MEMBER,
  });
  return { workspaceId, personId, ref };
}

const pendingOf = (personId: string) =>
  app.stepExecution.count({
    where: { personId, status: { in: ["planned", "awaiting_approval", "scheduled"] } },
  });
const statusesOf = async (personId: string) =>
  (await app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })).map(
    ({ stepKey, status }) => [stepKey, status],
  );
const eventsOf = (workspaceId: string, eventName: string) =>
  app.outboxEntry.findMany({ where: { workspaceId, eventName }, orderBy: { id: "asc" } });

test("a reply through the receiver holds every pending step within 60 seconds; the same event twice stores one message and publishes once; a 'remove me' reply suppresses the person", async (t) => {
  const modules = moduleLoaders.filter(({ name }) => name === "campaigns" || name === "inbox");
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    schedules: "off",
    client: app,
    log,
  });
  const connection = await Connection.connect({ address: workerConfig.TEMPORAL_ADDRESS });
  const temporal = new Client({ connection, namespace: workerConfig.TEMPORAL_NAMESPACE });
  try {
    const { workspaceId, personId, ref } = await enrolledReply();
    assert.equal(await pendingOf(personId), 3);

    const reply = fake.emitMessage(ref, { memberRef: MEMBER, text: "Thanks, next week works." });
    const answered = Date.now();
    await handleWebhook("fake", reply); // the route answers 204 after it
    await until(async () => (await pendingOf(personId)) === 0);
    const took = Date.now() - answered;
    assert.ok(took < STOP_WITHIN_MS, `the steps were held after ${took} ms`);
    t.diagnostic(`every pending step held ${took} ms after the receiver's answer`);
    assert.deepEqual(await statusesOf(personId), [
      ["connect", "succeeded"],
      ["message_1", "held"],
      ["follow_up_1", "held"],
      ["follow_up_2", "held"],
    ]);
    const enrollment = await app.enrollment.findFirstOrThrow({ where: { personId } });
    assert.equal(enrollment.status, "replied");
    const replied = await until(
      async () => (await eventsOf(workspaceId, "inbox.reply_received"))[0],
    );

    // The vendor delivers the event again: the receipt ends it. The outbox delivers its event again:
    // the run's id, the event's, starts none.
    await handleWebhook("fake", reply);
    const [received] = await eventsOf(workspaceId, "linkedin.message_received");
    assert.ok(received);
    const run = temporal.workflow.getHandle(`inbox.message:${workspaceId}:${received.id}`);
    const { runId } = await run.describe();
    await app.outboxEntry.update({ where: { id: received.id }, data: { deliveredAt: null } });
    await until(async () => {
      const row = await app.outboxEntry.findUniqueOrThrow({ where: { id: received.id } });
      return row.deliveredAt;
    });
    assert.equal((await run.describe()).runId, runId);
    assert.equal(await app.message.count({ where: { personId } }), 1);
    assert.deepEqual(
      (await eventsOf(workspaceId, "inbox.reply_received")).map(({ id }) => id),
      [replied.id],
    );
    assert.equal((await eventsOf(workspaceId, "linkedin.message_received")).length, 1);

    // A reply that asks to stop: the person's opt-out, by the system, for a reply.
    const stop = fake.emitMessage(ref, { memberRef: MEMBER, text: "Please remove me." });
    await handleWebhook("fake", stop);
    const matched = await until(() =>
      app.message.findFirst({ where: { personId, optOutMatched: true } }),
    );
    assert.equal(matched.direction, "in");
    const entries = await app.suppressionEntry.findMany({
      where: { workspaceId, layer: "opt_out" },
    });
    assert.deepEqual(
      entries.map(({ source, reason }) => [source, reason]),
      [["system", "reply_opt_out"]],
    );
    const lead = await app.lead.findFirstOrThrow({ where: { personId } });
    assert.equal(lead.outreachStatus, "suppressed");
  } finally {
    await host.close();
    await temporal.schedule
      .getHandle("campaigns.plan")
      .delete()
      .catch(() => undefined);
    await connection.close();
  }
});

// campaigns' subscriber to contacts.suppression_added (beta-p2-050; core/modules/campaigns/README.md
// "The suppression subscriber") through the outbox, on a schema of the slice's database: campaigns
// loaded from its build by the worker's own loader, the subscriber run by the worker's outbox loop
// (src/outbox.ts) in a tenant run as service:worker. A person blocked as a person, one blocked
// through their company and one who opted out, after enrollment: each active enrollment exited
// with its reason, its pending steps cancelled, a claimed step left to the sender, the lead kept
// suppressed, a clear person untouched, and a redelivery changing nothing. And the gate, before the
// event is delivered, skipping a step of a person blocked as a person or through their company.
// An address blocked on every channel (gamma-rf-040): the enrollment of the person who holds it
// exited by the event, or, when the address is recorded after its block, by the gate, with no
// event. The approver is the workspace's Owner, so the seeded campaign sends from their account
// (gamma-p6-040). Contacts', linkedin's and tenancy's code and test helpers come from their builds,
// as the loader's modules import them. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { Principal } from "@whytide/platform";

// The LinkedIn fake, whatever the environment names: nothing here calls a provider, and nothing may.
process.env.PROVIDER_LINKEDIN = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { startOutboxLoop } = await import("../src/outbox.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { approveLead } = await import(built("contacts/dist/domain/outreach/status.js"));
const { addSuppression } = await import(built("contacts/dist/domain/suppression/entries.js"));
const { checkGate } = await import(built("campaigns/dist/domain/gate/gate.js"));
const linkedin = await import(built("linkedin/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
linkedin.useLinkedinClient(app);
const log = platform.createLogger({ destination: platform.collectLogs().destination });
await loadModules(moduleLoaders.filter(({ name }) => name === "campaigns"));

const WORKSPACE = "wsp_campaigns_suppression";
const APPROVER = "usr_campaigns_approver";
const approver: Principal = {
  userId: APPROVER,
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const inRun = <T>(principal: Principal, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal }, fn, { client: app });
const asSystem = <T>(fn: (tx: TenantClient) => Promise<T>) =>
  inRun(platform.servicePrincipal("campaigns_test"), fn);
const asApprover = <T>(fn: () => Promise<T>) => inRun(approver, fn);
/**
 * The workspace with the approver its Owner, so the seeded campaign sends from the approver's
 * connected account (gamma-p6-040).
 */
async function ownedAccount(): Promise<void> {
  await tenancy.createOrganizationWithWorkspace({ workspaceId: WORKSPACE });
  await app.user.create({ data: { id: APPROVER, email: `${APPROVER}@example.com` } });
  await tenancy.createMembership({ userId: APPROVER, workspaceId: WORKSPACE, role: "Owner" });
  await linkedin.createConnectedAccount(WORKSPACE, { ownerUserId: APPROVER });
}

/** A person with a lead, at a company of the workspace when a domain is given: its id. */
const leadOf = (slug: string, domain?: string): Promise<string> =>
  asSystem(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "import", provider: "csv", profile },
    });
    await contacts.createLeadForPerson({
      personId: person.id,
      source: { kind: "imported", ref: "imp_1" },
    });
    if (domain !== undefined) {
      const { company } = await contacts.upsertCompany({
        ...{ source: "import", provider: "csv", company: { name: "Brackwater", domain } },
      });
      await contacts.linkPersonToCompany({ personId: person.id, companyId: company.id });
    }
    return person.id;
  });

/** The first truthy answer of `probe`, asked every 50 ms for 20 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 20 seconds");
    await sleep(50);
  }
}

/** The worker's outbox loop, run until every event is delivered, then stopped. */
async function deliver(): Promise<void> {
  const loop = startOutboxLoop(app, log);
  try {
    await until(async () => (await app.outboxEntry.count({ where: { deliveredAt: null } })) === 0);
  } finally {
    await loop.stop();
  }
}

/** Approved by the member and enrolled through the outbox: the person's steps by key. */
async function enrolled(personIds: string[]): Promise<void> {
  for (const personId of personIds) await asApprover(() => approveLead(personId));
  await deliver();
}
const stepsOf = async (personId: string) =>
  (await app.stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })).map(
    ({ id, stepKey, status, skipReason }) => ({ id, stepKey, status, skipReason }),
  );
const enrollmentOf = async (personId: string) => {
  const { status, exitReason, exitDetail } = await app.enrollment.findFirstOrThrow({
    where: { personId },
  });
  return { status, exitReason, exitDetail };
};
const statusOf = async (personId: string) =>
  (await app.lead.findFirstOrThrow({ where: { personId } })).outreachStatus;
const move = (id: string, status: "scheduled" | "executing") =>
  app.stepExecution.update({ where: { id }, data: { status } });
const connectOf = async (personId: string) => {
  const connect = (await stepsOf(personId)).find(({ stepKey }) => stepKey === "connect");
  assert.ok(connect);
  return connect.id;
};

test("contacts.suppression_added, delivered: each affected active enrollment exited with the reason, its pending steps cancelled, a claimed step left; a redelivery changes nothing", async () => {
  await ownedAccount();
  const blocked = await leadOf("suppression-person");
  const employee = await leadOf("suppression-company", "brackwater.example");
  const optedOut = await leadOf("suppression-opt-out");
  const clear = await leadOf("suppression-clear");
  await enrolled([blocked, employee, optedOut, clear]);
  // The sender has claimed the blocked person's connection request; the others' are scheduled.
  await move(await connectOf(blocked), "executing");
  for (const personId of [employee, optedOut, clear])
    await move(await connectOf(personId), "scheduled");
  const clearBefore = await stepsOf(clear);

  await asApprover(async () => {
    await addSuppression({ kind: "person", personId: blocked, createdBy: APPROVER });
    await addSuppression({ kind: "company", value: "brackwater.example", createdBy: APPROVER });
    await contacts.addOptOut(optedOut, { source: "system", reason: "reply_opt_out" });
  });
  await deliver();

  for (const [personId, reason] of [
    [blocked, "never_contact_person"],
    [employee, "never_contact_company"],
    [optedOut, "opted_out"],
  ] as const) {
    assert.deepEqual(await enrollmentOf(personId), {
      ...{ status: "exited", exitReason: "suppressed", exitDetail: reason },
    });
    const claimed = personId === blocked;
    assert.deepEqual(
      (await stepsOf(personId)).map(({ status, skipReason }) => [status, skipReason]),
      [
        claimed ? ["executing", null] : ["cancelled", reason],
        ["cancelled", reason],
        ["cancelled", reason],
        ["cancelled", reason],
      ],
      reason,
    );
    assert.equal(await statusOf(personId), "suppressed");
  }
  assert.equal((await enrollmentOf(clear)).status, "active");
  assert.deepEqual(await stepsOf(clear), clearBefore);
  assert.equal(await statusOf(clear), "in_campaign");

  // The events again, as after a crash between the handler's commit and the row's mark.
  const rows = {
    enrollments: await app.enrollment.findMany(),
    steps: await app.stepExecution.findMany(),
  };
  const due = { deliveredAt: null, nextAttemptAt: new Date(0) };
  await app.outboxEntry.updateMany({
    where: { eventName: "contacts.suppression_added" },
    data: due,
  });
  await deliver();
  assert.deepEqual(
    { enrollments: await app.enrollment.findMany(), steps: await app.stepExecution.findMany() },
    rows,
  );
});

test("the gate, before the event is delivered: a step of a person blocked as a person or through their company is skipped with the reason", async () => {
  await ownedAccount();
  const blocked = await leadOf("gate-person");
  const employee = await leadOf("gate-company", "harrowgate.example");
  await enrolled([blocked, employee]);
  for (const personId of [blocked, employee]) await move(await connectOf(personId), "scheduled");
  await asApprover(async () => {
    await addSuppression({ kind: "person", personId: blocked, createdBy: APPROVER });
    await addSuppression({ kind: "company", value: "harrowgate.example", createdBy: APPROVER });
  });

  for (const [personId, reason] of [
    [blocked, "never_contact_person"],
    [employee, "never_contact_company"],
  ] as const) {
    const connect = await connectOf(personId);
    const answer: { pass: boolean; reason?: string } = await asSystem(() =>
      checkGate(connect, { at: new Date() }),
    );
    assert.deepEqual([answer.pass, answer.reason], [false, reason]);
    assert.deepEqual(
      (await stepsOf(personId)).map(({ status, skipReason }) => [status, skipReason]),
      [["skipped", reason], ...Array(3).fill(["cancelled", reason])],
    );
    assert.deepEqual(await enrollmentOf(personId), {
      ...{ status: "exited", exitReason: "suppressed", exitDetail: reason },
    });
  }
  // The events, delivered next, meet no active enrollment of theirs.
  const rows = await app.stepExecution.findMany();
  await deliver();
  assert.deepEqual(await app.stepExecution.findMany(), rows);
});

test("an address blocked on every channel exits the enrollment of the person who holds it: by the event, or, recorded after its block, by the gate, with no event", async () => {
  await ownedAccount();
  const holder = await leadOf("address-holder");
  const later = await leadOf("address-later");
  const recorded = (personId: string, address: string) =>
    asSystem(() => contacts.recordPersonEmail({ personId, address }));
  assert.deepEqual(await recorded(holder, "noor.holder@brackwater.example"), {
    ...{ holder: "self", suppressed: false },
  });
  await enrolled([holder, later]);
  for (const personId of [holder, later]) await move(await connectOf(personId), "scheduled");

  await asApprover(async () => {
    for (const value of [" Noor.Holder@Brackwater.example ", "noor.later@brackwater.example"])
      await addSuppression({ kind: "person", value, createdBy: APPROVER });
  });
  await deliver();

  const reason = "never_contact_person";
  assert.deepEqual(await enrollmentOf(holder), {
    ...{ status: "exited", exitReason: "suppressed", exitDetail: reason },
  });
  assert.deepEqual(
    (await stepsOf(holder)).map(({ status, skipReason }) => [status, skipReason]),
    Array(4).fill(["cancelled", reason]),
  );
  assert.equal(await statusOf(holder), "suppressed");
  // No person held the second address when its entry came: the enrollment goes on, until one does.
  assert.equal((await enrollmentOf(later)).status, "active");
  assert.equal(await statusOf(later), "in_campaign");
  assert.deepEqual(await recorded(later, "noor.later@brackwater.example"), {
    ...{ holder: "self", suppressed: true },
  });
  assert.equal(await statusOf(later), "suppressed");
  const connect = await connectOf(later);
  const answer: { pass: boolean; reason?: string } = await asSystem(() =>
    checkGate(connect, { at: new Date() }),
  );
  assert.deepEqual([answer.pass, answer.reason], [false, reason]);
  assert.deepEqual(
    (await stepsOf(later)).map(({ status, skipReason }) => [status, skipReason]),
    [["skipped", reason], ...Array(3).fill(["cancelled", reason])],
  );
  assert.deepEqual(await enrollmentOf(later), {
    ...{ status: "exited", exitReason: "suppressed", exitDetail: reason },
  });
  const added = { eventName: "contacts.suppression_added" };
  assert.equal(await app.outboxEntry.count({ where: added }), 2, "the record published nothing");
});

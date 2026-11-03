// contacts' Approve and outreach status end to end (beta-p2-030; core/modules/contacts/README.md
// "Routes"): the host started with identity, whose resolver guards the workspace, and contacts, on
// the fake authentication adapter, in a schema of the worktree's database, answering real HTTP: the
// states Approve allows and refuses, its event and its repeat, the status changes, the `outreach`
// filter of the list, the neighbours and the CSV, and the Qualified date. It lives here: a module
// never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  addOptOut,
  applyQualification,
  createLeadForPerson,
  recordLeadStatus,
  recordTouch,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useContactsClient, useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useContactsClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const system = { type: "system" } as const;
/** In the tenant's workspace, as an import, qualification or a campaign writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** A qualified lead at the fit given, in the tenant's workspace; its person id. */
const lead = (tenant: TestTenant, slug: string, fitScore: number) =>
  asService(tenant, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Sam" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    await applyQualification({ personId: person.id, status: "qualified", fitScore, tier: "hot" });
    return person.id;
  });

type Answer = { status: number; body: any; replayed: string | null };
/**
 * A call to …/contacts/leads<path> in the tenant's workspace, from the app, as its Owner; a POST
 * carries a new Idempotency-Key unless `key` is given, or null.
 */
async function call(tenant: TestTenant, method: string, path: string, key?: string | null) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, origin: APP_ORIGIN };
  const idempotency = key === undefined ? randomUUID() : key;
  if (method === "POST" && idempotency !== null) headers["idempotency-key"] = idempotency;
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/contacts/leads${path}`, api.url);
  const res = await fetch(url, { method, headers });
  const text = await res.text();
  const replayed = res.headers.get("idempotent-replayed");
  const json = res.headers.get("content-type")?.startsWith("application/json");
  return { status: res.status, body: text && json ? JSON.parse(text) : text, replayed } as Answer;
}
const approve = (tenant: TestTenant, personId: string, key?: string | null) =>
  call(tenant, "POST", `/${personId}/approve`, key);
const approvals = (tenant: TestTenant) =>
  asRole("app").outboxEntry.findMany({
    where: { workspaceId: tenant.workspace.id, eventName: "contacts.lead_approved" },
  });
const approved = { status: 200, body: { outreachStatus: "approved" }, replayed: null };
const refused = (status: number, code: string, details?: object) => ({
  status,
  body: details ? { code, details } : { code },
  replayed: null,
});

test("POST …/approve on a pending_review lead: 200 approved, one change row, one contacts.lead_approved; the same key acts once; again from approved publishes again; the Qualified date stays", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await lead(a, "sam-approve", 80);
  const before = (await call(a, "GET", `/${personId}`)).body;
  assert.deepEqual([before.outreachStatus, before.outreachReason], ["pending_review", null]);

  const key = randomUUID();
  assert.deepEqual(await approve(a, personId, key), approved);
  assert.deepEqual(await approve(a, personId, key), { ...approved, replayed: "true" });
  assert.equal((await approvals(a)).length, 1, "a double press with one key acts once");
  const payload = { personId, approvedBy: a.user.id };
  assert.deepEqual((await approvals(a))[0]?.payload, payload);

  const after = (await call(a, "GET", `/${personId}`)).body;
  assert.equal(after.outreachStatus, "approved");
  assert.equal(after.updatedAt, before.updatedAt, "the Qualified date stays");
  const { changes } = (await call(a, "GET", `/${personId}/status-changes`)).body;
  assert.equal(changes.length, 1);
  const [{ id, createdAt, ...change }] = changes;
  assert.match(id, /^lsc_[0-9A-Z]{26}$/);
  assert.ok(Math.abs(Date.parse(createdAt) - Date.now()) < 60_000);
  assert.deepEqual(change, {
    personId,
    fromStatus: "pending_review",
    toStatus: "approved",
    templateId: null,
    reason: null,
    actorType: "user",
    actorId: a.user.id,
  });

  assert.deepEqual(await approve(a, personId), approved);
  assert.equal((await approvals(a)).length, 2, "from approved, the event again");
  const again = (await call(a, "GET", `/${personId}/status-changes`)).body.changes;
  assert.equal(again.length, 1, "and no second change");
});

test("POST …/approve refuses: person_suppressed with its reason, recently_contacted included; lead_in_outreach from in_campaign, replied and finished; lead_not_found, also for another workspace's lead; no key", async () => {
  const [a, b] = await createTwoWorkspaces();
  const optedOut = await lead(a, "sam-opted-out", 70);
  const touched = await lead(a, "sam-touched", 60);
  const campaigned = await lead(a, "sam-campaigned", 50);
  const theirs = await lead(b, "sam-theirs", 40);
  await asService(a, async () => {
    await addOptOut(optedOut, { source: "manual", createdBy: a.user.id });
    await recordTouch(touched, new Date());
  });
  assert.deepEqual(
    await approve(a, optedOut),
    refused(409, "person_suppressed", { reason: "opted_out" }),
  );
  assert.deepEqual(
    await approve(a, touched),
    refused(409, "person_suppressed", { reason: "recently_contacted" }),
  );
  for (const status of ["in_campaign", "replied", "finished"] as const) {
    await asService(a, () => recordLeadStatus(campaigned, status, { actor: system }));
    assert.deepEqual(await approve(a, campaigned), refused(409, "lead_in_outreach"), status);
  }
  assert.deepEqual(await approve(a, theirs), refused(404, "lead_not_found"));
  assert.deepEqual(await approve(a, "per_unknown"), refused(404, "lead_not_found"));
  const keyless = await approve(a, touched, null);
  assert.deepEqual([keyless.status, keyless.body.code], [400, "idempotency_key_required"]);
  assert.equal((await approvals(a)).length, 0);
  assert.deepEqual(
    await call(a, "GET", `/${theirs}/status-changes`),
    refused(404, "lead_not_found"),
  );
});

test("GET …/leads?outreach=approved filters the list, the neighbours and the CSV export; an unknown value answers 400", async () => {
  const [a] = await createTwoWorkspaces();
  const top = await lead(a, "sam-top", 90);
  const middle = await lead(a, "sam-middle", 80);
  const low = await lead(a, "sam-low", 70);
  for (const personId of [top, low]) await approve(a, personId);

  const list = (await call(a, "GET", "?outreach=approved")).body;
  assert.deepEqual(
    list.leads.map(({ personId }: { personId: string }) => personId),
    [top, low],
  );
  assert.ok(list.leads.every(({ outreachStatus }: any) => outreachStatus === "approved"));
  const pending = (await call(a, "GET", "?outreach=pending_review")).body;
  assert.deepEqual(
    pending.leads.map(({ personId }: { personId: string }) => personId),
    [middle],
  );
  const neighbours = (await call(a, "GET", `/${top}/neighbours?outreach=approved`)).body;
  assert.deepEqual(neighbours, { previous: null, next: low }, "the approved one after top: low");

  const exported = await fetch(
    new URL(
      `/v1/workspaces/${a.workspace.id}/contacts/exports/leads.csv?outreach=approved`,
      api.url,
    ),
    { headers: { cookie: cookieOf(a), origin: APP_ORIGIN } },
  );
  assert.equal(exported.status, 200);
  const lines = (await exported.text()).trim().split("\r\n");
  const urls = lines.slice(1).map((line) => line.split(",").at(-1));
  assert.deepEqual(urls, ["https://linkedin.com/in/sam-top", "https://linkedin.com/in/sam-low"]);

  for (const path of ["?outreach=meeting_booked", `/${top}/neighbours?outreach=meeting_booked`]) {
    const answer = await call(a, "GET", path);
    assert.deepEqual([answer.status, answer.body.code], [400, "validation_failed"], path);
  }
  const unknown = await fetch(
    new URL(
      `/v1/workspaces/${a.workspace.id}/contacts/exports/leads.csv?outreach=discovered`,
      api.url,
    ),
    { headers: { cookie: cookieOf(a), origin: APP_ORIGIN } },
  );
  assert.equal(unknown.status, 400);
});

function cookieOf(tenant: TestTenant) {
  return signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
}

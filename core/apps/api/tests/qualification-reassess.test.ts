// qualification's new assessment route end to end (lead-rescore-ai; core/modules/qualification/
// README.md "A new assessment"): the host started with identity and qualification, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. A
// not_qualified lead and a hard_filtered one go back to pending with member_requested, each with its
// event in the outbox; a pending lead changes nothing; a Member is refused, and another workspace's
// lead is lead_not_found. The batch the event starts is the worker's test (core/apps/worker/tests/
// qualification-reassess.test.ts). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { applyQualification, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// qualification by its build's path, as src/modules.generated.ts loads it.
const qualification = new URL("../../../../modules/qualification/dist/index.js", import.meta.url);
const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "qualification", load: () => import(qualification.href) },
];
const EVENT = "qualification.reassess_requested";
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** In the tenant's workspace, as the batch writes. */
const asService = <T>({ workspace }: TestTenant, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("qualification_test") }, fn, {
    client: asRole("app"),
  });
type Decision = (personId: string, tx: TenantClient, workspaceId: string) => Promise<unknown>;
/** A lead of a person imported in the tenant's workspace, decided in the same run; its id. */
const seed = (tenant: TestTenant, slug: string, decision?: Decision) =>
  asService(tenant, async (tx) => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    await decision?.(person.id, tx, tenant.workspace.id);
    return person.id;
  });
/** not_qualified at version 1 from a scored snapshot of its own, as the batch leaves it. */
const notQualified: Decision = async (personId, tx, workspaceId) => {
  const id = `ssn_${randomUUID().replaceAll("-", "")}`;
  const scores = { status: "not_qualified", fitScore: 31, confidence: "high" } as const;
  await tx.scoreSnapshot.create({
    data: {
      ...{ id, workspaceId, personId, icpVersion: 1 },
      ...{ modelId: "fake-model", promptVersion: 2, scorerVersion: "fit-v1" },
      ...{ ...scores, tier: "cool", summary: "A data head.", disqualifiers: [] },
      decisionRecordId: "dr_1",
    },
  });
  await applyQualification({ personId, ...scores, snapshotId: id, icpVersion: 1 });
};
const hardFiltered: Decision = (personId) =>
  applyQualification({
    personId,
    status: "hard_filtered",
    reason: "country_mismatch",
    icpVersion: 1,
  });

/** A user of the tenant's workspace in `role`. */
async function userOf({ workspace }: TestTenant, role: "Admin" | "Member") {
  const user = await createUser();
  await createMembership({ userId: user.id, workspaceId: workspace.id, role });
  return user.id;
}
/** POST …/qualification/leads/{personId}/reassess in the tenant's workspace as the user. */
async function reassess(tenant: TestTenant, userId: string, personId: string, key = randomUUID()) {
  const path = `/v1/workspaces/${tenant.workspace.id}/qualification/leads/${personId}/reassess`;
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers = { cookie, origin: APP_ORIGIN, "idempotency-key": key };
  const res = await fetch(new URL(path, api.url), { method: "POST", headers });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body };
}
const leadOf = (personId: string) =>
  asRole("app").lead.findFirstOrThrow({
    where: { personId },
    select: { qualificationStatus: true, statusReason: true, currentScoreSnapshotId: true },
  });
const pressed = ({ workspace }: TestTenant) =>
  asRole("app").outboxEntry.findMany({
    where: { workspaceId: workspace.id, eventName: EVENT },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

test("POST …/reassess answers 202: a not_qualified lead and a hard_filtered one go back to pending, member_requested, its snapshot kept, each with qualification.reassess_requested; its key answered again without a second; a pending lead changes nothing", async () => {
  const [a] = await createTwoWorkspaces();
  const scored = await seed(a, "reassess-scored", notQualified);
  const filtered = await seed(a, "reassess-filtered", hardFiltered);
  const pending = await seed(a, "reassess-pending");
  const { currentScoreSnapshotId: snapshotId } = await leadOf(scored);
  assert.notEqual(snapshotId, null);

  const key = randomUUID();
  const first = await reassess(a, a.user.id, scored, key);
  assert.deepEqual(first, {
    status: 202,
    replayed: null,
    body: { status: "pending", requested: true },
  });
  assert.deepEqual(await reassess(a, a.user.id, scored, key), { ...first, replayed: "true" });
  const admin = await userOf(a, "Admin");
  assert.deepEqual((await reassess(a, admin, filtered)).body, {
    status: "pending",
    requested: true,
  });
  assert.deepEqual(await leadOf(scored), {
    qualificationStatus: "pending",
    statusReason: "member_requested",
    currentScoreSnapshotId: snapshotId,
  });
  assert.deepEqual(await leadOf(filtered), {
    qualificationStatus: "pending",
    statusReason: "member_requested",
    currentScoreSnapshotId: null,
  });
  const workspaceId = a.workspace.id;
  assert.deepEqual(
    (await pressed(a)).map((row) => row.payload),
    [scored, filtered].map((personId) => ({ workspaceId, personId })),
  );

  const waiting = await reassess(a, a.user.id, pending);
  assert.deepEqual([waiting.status, waiting.body], [202, { status: "pending", requested: false }]);
  assert.deepEqual(await leadOf(pending), {
    qualificationStatus: "pending",
    statusReason: null,
    currentScoreSnapshotId: null,
  });
  assert.equal((await pressed(a)).length, 2);
});

test("POST …/reassess: a Member gets 403 and the lead stays; another workspace's lead, and an unknown person, 404 lead_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const filtered = await seed(a, "refused-filtered", hardFiltered);
  const member = await userOf(a, "Member");
  const refused = await reassess(a, member, filtered);
  assert.equal(refused.status, 403);
  assert.equal((await leadOf(filtered)).qualificationStatus, "hard_filtered");

  const theirs = await seed(b, "refused-theirs", hardFiltered);
  const crossed = await reassess(a, a.user.id, theirs);
  assert.deepEqual([crossed.status, crossed.body.code], [404, "lead_not_found"]);
  assert.equal((await leadOf(theirs)).qualificationStatus, "hard_filtered");
  const unknown = await reassess(a, a.user.id, "per_unknown");
  assert.deepEqual([unknown.status, unknown.body.code], [404, "lead_not_found"]);
  assert.equal((await pressed(a)).length + (await pressed(b)).length, 0);
});

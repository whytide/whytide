// qualification's member's verdict routes end to end (lead-verdict-edit; core/modules/qualification
// README "A member's verdict"): the host started with identity, contacts and qualification, on the
// fake authentication adapter, in a schema of the worktree's database, answering real HTTP. A
// signed-in member sets, changes and clears the verdict of a criterion of a needs_review lead's
// snapshot, each answer the snapshot read again and the lead decided again, the event on a status
// change only; the refusals. The module's own tests/member-verdict.test.ts proves the decisions
// against fit-v1's decide and the re-score. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyQualification, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// qualification by its build's path, as src/modules.generated.ts loads it: the api lists it nowhere.
const qualification = new URL("../../../../modules/qualification/dist/index.js", import.meta.url);
const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
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
      { name: "qualification", load: () => import(qualification.href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/**
 * The model's verdicts of a needs_review lead under the default criteria: location, a must, unknown.
 * Weights and points as fit-v1 leaves them: (300 + 150 + 100 + 150 + 40 + 200) / 100 is 94.
 */
const VERDICTS = [
  { criterion: "title_function", verdict: "met", evidence: "Head of Data", weight: 30, points: 1 },
  { criterion: "seniority", verdict: "met", evidence: "Head of Data", weight: 15, points: 1 },
  { criterion: "company_size", verdict: "met", evidence: "51-200", weight: 10, points: 1 },
  { criterion: "industry", verdict: "met", evidence: "Software", weight: 15, points: 1 },
  { criterion: "location", verdict: "unknown", evidence: "", weight: 10, points: 0.4 },
  { criterion: "must_haves", verdict: "met", evidence: "Runs a data team", weight: 20, points: 1 },
] as const;
const DECIDED = { fitScore: 94, confidence: "high", tier: "hot", status: "needs_review" } as const;
const run = <T>({ workspace }: TestTenant, fn: Parameters<typeof withTenant<T>>[1]) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("qualification_test") }, fn, {
    client: asRole("app"),
  });

/** A person and its lead; with `scored`, the needs_review snapshot above, the lead pointing at it. */
const seed = (tenant: TestTenant, slug: string, scored: boolean) =>
  run(tenant, async (tx) => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    const personId = person.id;
    await createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } });
    if (!scored) return personId;
    const snapshotId = newId("ssn");
    const workspaceId = tenant.workspace.id;
    await tx.scoreSnapshot.create({
      data: {
        ...DECIDED,
        id: snapshotId,
        workspaceId,
        personId,
        icpVersion: 2,
        modelId: "fake-model",
        promptVersion: 1,
        scorerVersion: "fit-v1",
        disqualifiers: [],
        summary: "A data leader.",
        decisionRecordId: `dr_${snapshotId}`,
      },
    });
    await tx.criterionVerdict.createMany({
      data: VERDICTS.map((row) => ({ ...row, id: newId("cvd"), workspaceId, snapshotId })),
    });
    await applyQualification({ personId, ...DECIDED, snapshotId, icpVersion: 2 });
    return personId;
  });

/** The route of the person's criterion, signed in as the user, with the body for a PUT. */
async function call(
  method: "PUT" | "DELETE",
  { workspace, user }: TestTenant,
  personId: string,
  criterion: string,
  body?: unknown,
) {
  const cookie = signInAs(user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const path = `/v1/workspaces/${workspace.id}/qualification/leads/${personId}/verdicts/${criterion}`;
  const headers = { cookie, origin: APP_ORIGIN, "content-type": "application/json" };
  const init = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  const res = await fetch(new URL(path, api.url), init);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

type Answer = { status: string; verdicts: { criterion: string; member: unknown }[] };
const verdictOf = (body: Record<string, unknown>, criterion: string) =>
  (body as Answer).verdicts.find((verdict) => verdict.criterion === criterion);

test("PUT …/verdicts/{criterion} sets a member's verdict and DELETE clears it: each answers the snapshot read again, the lead decided again, the event on a status change only", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await seed(a, "ines-review", true);
  const lead = () => run(a, (tx) => tx.lead.findFirstOrThrow({ where: { personId } }));
  const events = () =>
    run(a, (tx) => tx.outboxEntry.count({ where: { eventName: "qualification.lead_qualified" } }));

  const set = await call("PUT", a, personId, "location", { verdict: "met", note: "Berlin" });
  assert.equal(set.status, 200);
  const { member, ...location } = verdictOf(set.body, "location") as Record<string, unknown>;
  assert.deepEqual(location, {
    criterion: "location",
    verdict: "met",
    modelVerdict: "unknown",
    evidence: "",
    weight: 10,
    points: 1,
  });
  const { setAt, ...part } = member as Record<string, unknown>;
  assert.deepEqual(part, { verdict: "met", note: "Berlin", setBy: a.user.id, mine: true });
  assert.ok(Date.parse(String(setAt)) > 0);
  // Its last unknown set, the lead leaves needs_review: (940 + 60) / 100 is 100.
  assert.deepEqual([set.body.status, set.body.fitScore], ["qualified", 100]);
  const decided = await lead();
  assert.deepEqual([decided.qualificationStatus, decided.fitScore], ["qualified", 100]);
  assert.equal(await events(), 1);

  const changed = await call("PUT", a, personId, "location", { verdict: "partially_met" });
  assert.deepEqual(
    [changed.status, changed.body.status, changed.body.fitScore],
    [200, "qualified", 95],
  );
  assert.equal(await events(), 1, "the status did not move");

  const cleared = await call("DELETE", a, personId, "location");
  assert.equal(cleared.status, 200);
  assert.deepEqual(verdictOf(cleared.body, "location"), {
    criterion: "location",
    verdict: "unknown",
    modelVerdict: "unknown",
    evidence: "",
    weight: 10,
    points: 0.4,
    member: null,
  });
  assert.deepEqual(
    [cleared.body.status, (await lead()).qualificationStatus],
    ["needs_review", "needs_review"],
  );
  assert.equal(await events(), 2);
});

test("refused: a criterion or a verdict off the lists, 400; a lead never scored and another workspace's person, 404", async () => {
  const [a, b] = await createTwoWorkspaces();
  const personId = await seed(a, "ines-refused", true);
  const pending = await seed(a, "ines-pending", false);
  const theirs = await seed(b, "ines-refused", true);
  const invalid = (fields: string[]) => ({
    status: 400,
    body: { code: "validation_failed", details: { fields } },
  });
  assert.deepEqual(
    await call("PUT", a, personId, "budget", { verdict: "met" }),
    invalid(["criterion"]),
  );
  assert.deepEqual(await call("DELETE", a, personId, "budget"), invalid(["criterion"]));
  assert.deepEqual(
    await call("PUT", a, personId, "location", { verdict: "maybe" }),
    invalid(["verdict"]),
  );
  assert.deepEqual(await call("PUT", a, pending, "location", { verdict: "met" }), {
    status: 404,
    body: { code: "score_snapshot_not_found" },
  });
  assert.deepEqual(await call("PUT", a, theirs, "location", { verdict: "met" }), {
    status: 404,
    body: { code: "lead_not_found" },
  });
  assert.deepEqual(await call("DELETE", a, theirs, "location"), {
    status: 404,
    body: { code: "lead_not_found" },
  });
  const untouched = await run(b, (tx) =>
    tx.criterionVerdict.count({ where: { memberVerdict: { not: null } } }),
  );
  assert.equal(untouched, 0);
});

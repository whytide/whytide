// contacts' edit of a lead's person end to end (lead-fields-edit; core/modules/contacts/README.md
// "Routes"): the host started with identity, whose resolver guards the workspace, and contacts, on
// the fake authentication adapter, in a schema of the worktree's database, answering real HTTP. A
// Member edits each of the six fields and clears one; the first name emptied, a value too long and a
// field off the six are refused with nothing written; another workspace's person and an unknown one
// are lead_not_found; the decision, the statuses and the outbox stay as they were; and a later fetch,
// one-row or batched, leaves the member's values in place. It lives here: a module never imports a
// host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  applyQualification,
  createLeadForPerson,
  upsertPersonFromSource,
  upsertPersonsFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
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
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
const logs = collectLogs();
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const fetchedAt = new Date("2026-10-01T08:00:00Z");
const linkedin = { source: "linkedin", provider: "unipile", at: fetchedAt.toISOString() };
const profile = (slug: string) => ({
  linkedinUrl: `https://linkedin.com/in/${slug}`,
  providerId: `member-${slug}`,
  firstName: "Elif",
  lastName: "Example",
  headline: "Data leader at a software company",
  title: "Head of Data",
  companyName: "Blue Harbor Labs",
  locationText: "Lisbon, Portugal",
  fetchedAt,
});
/** In the tenant's workspace, as a signal run or qualification writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** A person from LinkedIn and its qualified lead, in the tenant's workspace; its id. */
const seed = (tenant: TestTenant, slug: string) =>
  asService(tenant, async () => {
    const source = { source: "linkedin", provider: "unipile", profile: profile(slug) } as const;
    const { person } = await upsertPersonFromSource(source);
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "src_1" } });
    const why = [{ key: "qualification.why.fit", params: { title: "Head of Data" } }];
    const decision = {
      status: "qualified",
      fitScore: 82,
      confidence: "high",
      tier: "hot",
    } as const;
    await applyQualification({ personId: person.id, ...decision, why });
    return person.id;
  });
/** A Member, no Owner, of the tenant's workspace: the role the edit is for. */
async function memberOf({ workspace }: TestTenant) {
  const user = await createUser();
  await createMembership({ userId: user.id, workspaceId: workspace.id, role: "Member" });
  return user.id;
}

type Answer = { status: number; body: any };
/** A call to …/contacts/leads/<path> in the tenant's workspace, from the app, as the user. */
async function call(tenant: TestTenant, userId: string, path: string, body?: object) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/contacts/leads/${path}`, api.url);
  const headers = { cookie, origin: APP_ORIGIN, "content-type": "application/json" };
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "PATCH",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() } as Answer;
}
const outbox = ({ workspace }: TestTenant) =>
  asRole("app").outboxEntry.count({ where: { workspaceId: workspace.id } });
const stamped = (stamp: { source: string; at: string }) =>
  stamp.source === "member" && !Number.isNaN(Date.parse(stamp.at));

test("PATCH …/contacts/leads/{personId}: a Member edits each of the six fields, trimmed; the answer is the lead as its read answers it, each changed field stamped member, the country following the location; the decision, the statuses and the outbox stay", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await seed(a, "elif-edit");
  const member = await memberOf(a);
  const before = await call(a, member, personId);
  const events = await outbox(a);

  const edit = {
    firstName: " Elif Su ",
    lastName: "Example-Kaya",
    headline: "Runs the data team",
    title: "  VP Data",
    companyName: "Harbor Data",
    locationText: "Berlin, Germany ",
  };
  const edited = await call(a, member, personId, edit);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const { person } = edited.body;
  assert.deepEqual(
    [person.firstName, person.lastName, person.headline, person.title, person.companyName],
    ["Elif Su", "Example-Kaya", "Runs the data team", "VP Data", "Harbor Data"],
  );
  assert.deepEqual([person.locationText, person.locationCountry], ["Berlin, Germany", "DE"]);
  for (const field of [...Object.keys(edit), "locationCountry"])
    assert.ok(stamped(person.provenance[field]), field);
  assert.deepEqual(person.provenance.linkedinUrl, linkedin, "the URL keeps its source");
  assert.equal(person.linkedinUrl, "https://linkedin.com/in/elif-edit");
  assert.deepEqual(edited.body, (await call(a, member, personId)).body, "the lead as its read");

  const { person: _before, ...decision } = before.body;
  const { person: _after, ...after } = edited.body;
  assert.deepEqual(after, decision, "the lead's row as it was: its decision, why and statuses");
  assert.equal(await outbox(a), events, "no event published");

  // A field sent as it is keeps its value and its stamp; one changed again takes a new stamp.
  const again = await call(a, member, personId, { title: "VP Data", headline: "Data lead" });
  assert.deepEqual(again.body.person.provenance.title, person.provenance.title);
  assert.equal(again.body.person.headline, "Data lead");
});

test("an empty value clears an optional field, which keeps the member's stamp; the first name emptied, a value too long and a field off the six are refused, naming the field, and nothing is written", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await seed(a, "elif-clear");
  const member = await memberOf(a);

  const cleared = await call(a, member, personId, { headline: "", locationText: "  " });
  assert.equal(cleared.status, 200);
  const { person } = cleared.body;
  assert.deepEqual(
    [person.headline, person.locationText, person.locationCountry],
    [null, null, null],
  );
  assert.ok(stamped(person.provenance.headline) && stamped(person.provenance.locationText));
  assert.equal(person.provenance.locationCountry, undefined);

  const before = (await call(a, member, personId)).body;
  const invalid = "contacts_input_invalid";
  // The body, the code, and the fields it names: a field off the six is the host's refusal.
  const refusals: [object, string, string[]?][] = [
    [{ firstName: "  " }, invalid, ["firstName"]],
    [{ firstName: "" }, invalid, ["firstName"]],
    [{ title: "t".repeat(301), lastName: "Kaya" }, invalid, ["title"]],
    [{ lastName: "x".repeat(101) }, invalid, ["lastName"]],
    [{ title: 42 }, "validation_failed", ["title"]],
    [{ linkedinUrl: "https://linkedin.com/in/someone-else" }, "validation_failed"],
    [{ locationCountry: "FR" }, "validation_failed"],
    [{ companyId: "wco_0" }, "validation_failed"],
  ];
  for (const [body, code, fields] of refusals) {
    const answer = await call(a, member, personId, body);
    assert.deepEqual([answer.status, answer.body.code], [400, code], JSON.stringify(body));
    if (fields) assert.deepEqual(answer.body.details, { fields });
  }
  assert.deepEqual((await call(a, member, personId)).body, before, "nothing written");
  // A refusal names the fields, never a value.
  const said = logs.raw.join("");
  assert.equal(said.includes("t".repeat(301)) || said.includes("someone-else"), false);
});

test("another workspace's person, an unknown one and one without a lead are lead_not_found, and nothing is written", async () => {
  const [a, b] = await createTwoWorkspaces();
  const theirs = await seed(b, "elif-theirs");
  const member = await memberOf(a);
  const lone = await asService(a, async () => {
    const source = { source: "import", provider: "csv", profile: profile("elif-lone") } as const;
    return (await upsertPersonFromSource(source)).person.id;
  });
  for (const personId of [theirs, "per_00000000000000000000000000", lone]) {
    assert.deepEqual(await call(a, member, personId, { title: "CTO" }), {
      status: 404,
      body: { code: "lead_not_found" },
    });
  }
  const read = await call(b, b.user.id, theirs);
  assert.deepEqual(
    [read.body.person.title, read.body.person.provenance.title],
    ["Head of Data", linkedin],
  );
});

test("a later fetch, one-row or batched, from LinkedIn or an import, leaves the member's values in place and fills the fields the member left", async () => {
  const [a] = await createTwoWorkspaces();
  const personId = await seed(a, "elif-later");
  const member = await memberOf(a);
  const edit = { title: "VP Data", locationText: "Berlin, Germany", headline: "" };
  const edited = (await call(a, member, personId, edit)).body.person;

  const later = new Date(Date.now() + 3_600_000);
  const fresh = {
    ...profile("elif-later"),
    title: "Analyst",
    locationText: "Paris, France",
    headline: "A headline from LinkedIn",
    companyName: "Blue Harbor Labs Ltd",
    fetchedAt: later,
  };
  await asService(a, async () => {
    await upsertPersonFromSource({ source: "linkedin", provider: "unipile", profile: fresh });
    await upsertPersonsFromSource([{ source: "import", provider: "csv", profile: fresh }]);
  });
  const { person } = (await call(a, member, personId)).body;
  assert.deepEqual(
    [person.title, person.locationText, person.locationCountry, person.headline],
    ["VP Data", "Berlin, Germany", "DE", null],
  );
  for (const field of ["title", "locationText", "locationCountry", "headline"])
    assert.deepEqual(person.provenance[field], edited.provenance[field], field);
  assert.equal(person.companyName, "Blue Harbor Labs Ltd", "a field the member left takes it");
  assert.equal(person.provenance.companyName.source, "import");
});

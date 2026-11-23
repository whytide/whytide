// contacts' lead added by hand end to end (lead-manual-create; core/modules/contacts/README.md
// "Routes"): the host started with identity, whose resolver guards the workspace, and contacts, on
// the fake authentication adapter, in a schema of the worktree's database, answering real HTTP. A
// Member adds a lead with every field and one with the URL and the first name, the URL normalized;
// a URL that is no profile, no first name, a value too long and a field off the body are refused
// with nothing written; a person with a lead is lead_exists naming the person, an erased one
// person_erased; a person without a lead takes the member's values as an edit; another workspace
// sees none of it; and a later fetch from LinkedIn keeps the member's values and fills a field left
// empty. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  createLeadForPerson,
  findPersonByLinkedinUrl,
  recordHash,
  upsertPersonFromSource,
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
/** In the tenant's workspace, as a signal run or an import writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** A person from LinkedIn in the tenant's workspace, without a lead; its id. */
const personFromLinkedin = (tenant: TestTenant, slug: string) =>
  asService(tenant, async () => {
    const source = { source: "linkedin", provider: "unipile", profile: profile(slug) } as const;
    return (await upsertPersonFromSource(source)).person.id;
  });
/** A Member, no Owner, of the tenant's workspace: Add lead is every member's (contacts.write). */
async function memberOf({ workspace }: TestTenant) {
  const user = await createUser();
  await createMembership({ userId: user.id, workspaceId: workspace.id, role: "Member" });
  return user.id;
}

type Answer = { status: number; body: any };
/**
 * A call to …/contacts/leads[/<path>] in the tenant's workspace, from the app, as the user: a GET,
 * or a POST with the body.
 */
async function call(tenant: TestTenant, userId: string, path: string, body?: unknown) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const leads = `/v1/workspaces/${tenant.workspace.id}/contacts/leads`;
  const url = new URL(path === "" ? leads : `${leads}/${path}`, api.url);
  const headers = { cookie, origin: APP_ORIGIN, "content-type": "application/json" };
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() } as Answer;
}
const add = (tenant: TestTenant, userId: string, body: unknown) => call(tenant, userId, "", body);
const outbox = ({ workspace }: TestTenant) =>
  asRole("app").outboxEntry.count({ where: { workspaceId: workspace.id } });
const stamped = (stamp: { source: string; at: string }) =>
  stamp.source === "member" && !Number.isNaN(Date.parse(stamp.at));

test("POST …/contacts/leads: a Member adds a lead with every field, trimmed; 201 with the lead as its read answers it, pending, its one source the member's manual entry, each given field stamped member, the country following the location; no event published", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const events = await outbox(a);

  const added = await add(a, member, {
    linkedinUrl: "https://www.linkedin.com/in/Ada-Hand",
    firstName: " Ada ",
    lastName: "Hand",
    headline: "Runs the data team",
    title: "Head of Data  ",
    companyName: "Blue Harbor Labs",
    locationText: "Berlin, Germany",
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { person, ...lead } = added.body;
  assert.deepEqual(
    [lead.qualificationStatus, lead.sourceLabel, lead.fitScore, lead.tier, lead.why],
    ["pending", "manual", null, null, []],
  );
  const at = person.provenance.firstName.at;
  assert.deepEqual(lead.sources, [{ kind: "manual", ref: member, at }], "no label, no URL");
  assert.equal(Date.parse(lead.firstSourceAt), Date.parse(at));
  assert.equal(person.linkedinUrl, "https://linkedin.com/in/ada-hand");
  assert.deepEqual(
    [person.firstName, person.lastName, person.headline, person.title, person.companyName],
    ["Ada", "Hand", "Runs the data team", "Head of Data", "Blue Harbor Labs"],
  );
  assert.deepEqual([person.locationText, person.locationCountry], ["Berlin, Germany", "DE"]);
  const fields = [
    ...["linkedinUrl", "firstName", "lastName", "headline", "title", "companyName"],
    ...["locationText", "locationCountry"],
  ];
  assert.deepEqual(Object.keys(person.provenance).sort(), fields.sort());
  for (const field of fields) {
    assert.deepEqual(person.provenance[field], { source: "member", provider: null, at }, field);
  }
  assert.deepEqual(added.body, (await call(a, member, person.id)).body, "the lead as its read");
  assert.equal(await outbox(a), events, "no event published");
});

test("the URL and the first name alone: the other fields none and unstamped, an empty one left out; a URL without its scheme, with `www.`, a capital, a query or a trailing slash is normalized", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const urls = [
    ["linkedin.com/in/bo-bare", "https://linkedin.com/in/bo-bare"],
    ["https://www.linkedin.com/in/Bo-Slash/", "https://linkedin.com/in/bo-slash"],
    [" http://linkedin.com/in/bo-query?trk=profile#top ", "https://linkedin.com/in/bo-query"],
  ];
  for (const [linkedinUrl, normalized] of urls) {
    const added = await add(a, member, { linkedinUrl, firstName: "Bo", lastName: "", title: " " });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const { person } = added.body;
    assert.equal(person.linkedinUrl, normalized);
    assert.deepEqual(
      [person.firstName, person.lastName, person.headline, person.title, person.companyName],
      ["Bo", null, null, null, null],
    );
    assert.deepEqual([person.locationText, person.locationCountry], [null, null]);
    assert.deepEqual(Object.keys(person.provenance).sort(), ["firstName", "linkedinUrl"]);
    assert.ok(stamped(person.provenance.firstName) && stamped(person.provenance.linkedinUrl));
  }
});

test("a URL that is no profile, no first name, a value too long and a field off the body are refused, naming the fields, never a value, and nothing is written", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const events = await outbox(a);
  const url = "https://linkedin.com/in/cy-refused";
  const invalid = "contacts_input_invalid";
  // The body, the code, and the fields it names: a field off the body is the host's refusal.
  const refusals: [object, string, string[]?][] = [
    [
      { linkedinUrl: "https://linkedin.com/company/blue-harbor", firstName: "Cy" },
      "linkedin_url_invalid",
    ],
    [{ linkedinUrl: "https://example.com/in/cy-refused", firstName: "Cy" }, "linkedin_url_invalid"],
    [{ linkedinUrl: "cy-refused", firstName: "Cy" }, "linkedin_url_invalid"],
    [{ linkedinUrl: " ", firstName: "Cy" }, "linkedin_url_invalid"],
    [{ linkedinUrl: url }, invalid, ["firstName"]],
    [{ linkedinUrl: url, firstName: "  ", title: "CTO" }, invalid, ["firstName"]],
    [{ linkedinUrl: url, firstName: "Cy", title: "t".repeat(301) }, invalid, ["title"]],
    [
      { linkedinUrl: url, firstName: "x".repeat(101), lastName: "y".repeat(101) },
      invalid,
      ["firstName", "lastName"],
    ],
    [{ firstName: "Cy" }, "validation_failed", ["linkedinUrl"]],
    [{ linkedinUrl: url, firstName: 42 }, "validation_failed", ["firstName"]],
    [{ linkedinUrl: url, firstName: "Cy", locationCountry: "FR" }, "validation_failed"],
    [{ linkedinUrl: url, firstName: "Cy", providerId: "member-cy" }, "validation_failed"],
  ];
  for (const [body, code, fields] of refusals) {
    const answer = await add(a, member, body);
    assert.deepEqual([answer.status, answer.body.code], [400, code], JSON.stringify(body));
    if (fields) assert.deepEqual(answer.body.details, { fields }, JSON.stringify(body));
  }
  assert.equal(await asService(a, () => findPersonByLinkedinUrl(url)), null, "nothing written");
  assert.deepEqual((await call(a, member, "")).body.leads, []);
  assert.equal(await outbox(a), events);
  // A refusal names the fields, never a value.
  const said = logs.raw.join("");
  assert.equal(said.includes("t".repeat(301)) || said.includes("cy-refused"), false);
});

test("a person who has a lead is lead_exists naming the person, and nothing changes, a lead added by hand too; an erased person is person_erased, and nothing is written", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const personId = await personFromLinkedin(a, "dee-lead");
  await asService(a, () =>
    createLeadForPerson({ personId, source: { kind: "signal", ref: "src_1" } }),
  );
  const before = await call(a, member, personId);
  const events = await outbox(a);

  const body = { linkedinUrl: "linkedin.com/in/Dee-Lead/", firstName: "Dee", title: "CTO" };
  const exists = { status: 409, body: { code: "lead_exists", details: { personId } } };
  assert.deepEqual(await add(a, member, body), exists);
  assert.deepEqual((await call(a, member, personId)).body, before.body, "nothing changed");

  const twice = { linkedinUrl: "https://linkedin.com/in/dee-twice", firstName: "Dee" };
  const first = await add(a, member, twice);
  assert.equal(first.status, 201);
  const again = await add(a, member, { ...twice, title: "CEO" });
  const theirs = { code: "lead_exists", details: { personId: first.body.personId } };
  assert.deepEqual(again, { status: 409, body: theirs });
  assert.deepEqual((await call(a, member, first.body.personId)).body, first.body);

  const erasedUrl = "https://linkedin.com/in/dee-erased";
  await asService(a, () => recordHash({ linkedinUrl: erasedUrl, kind: "erased" }));
  const erased = { linkedinUrl: "https://www.linkedin.com/in/dee-erased/", firstName: "Dee" };
  assert.deepEqual(await add(a, member, erased), { status: 409, body: { code: "person_erased" } });
  assert.equal(await asService(a, () => findPersonByLinkedinUrl(erasedUrl)), null);
  assert.equal(await outbox(a), events, "no event published");
});

test("a person without a lead takes the member's values as an edit, the fields left keeping their source's values and stamps, and gets the member's lead", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const personId = await personFromLinkedin(a, "eve-lone");

  const body = {
    linkedinUrl: "https://linkedin.com/in/eve-lone",
    firstName: "Eve",
    title: "VP Data",
    lastName: "Example",
    headline: "",
  };
  const added = await add(a, member, body);
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const { person, ...lead } = added.body;
  assert.equal(person.id, personId);
  assert.deepEqual([lead.qualificationStatus, lead.sourceLabel], ["pending", "manual"]);
  assert.deepEqual(
    [person.firstName, person.lastName, person.headline, person.title, person.companyName],
    ["Eve", "Example", "Data leader at a software company", "VP Data", "Blue Harbor Labs"],
  );
  assert.ok(stamped(person.provenance.firstName) && stamped(person.provenance.title));
  // A value sent as it is keeps its source's stamp; an empty one is none, and clears nothing.
  for (const field of ["linkedinUrl", "lastName", "headline", "companyName", "locationText"]) {
    assert.deepEqual(person.provenance[field], linkedin, field);
  }
});

test("another workspace sees nothing: its Owner reads no lead of the person and lists none, adds the same URL as its own person, and a member of the first cannot add in it", async () => {
  const [a, b] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const body = { linkedinUrl: "https://linkedin.com/in/fay-ours", firstName: "Fay" };
  const ours = await add(a, member, { ...body, companyName: "Ours" });
  assert.equal(ours.status, 201);
  const id = ours.body.person.id;

  assert.deepEqual(await call(b, b.user.id, id), {
    status: 404,
    body: { code: "lead_not_found" },
  });
  assert.deepEqual((await call(b, b.user.id, "")).body.leads, []);
  const theirs = await add(b, b.user.id, { ...body, companyName: "Theirs" });
  assert.equal(theirs.status, 201);
  assert.notEqual(theirs.body.person.id, id);
  assert.equal((await call(a, member, id)).body.person.companyName, "Ours");
  assert.deepEqual(await add(b, member, { ...body, linkedinUrl: "linkedin.com/in/fay-cross" }), {
    status: 403,
    body: { code: "forbidden" },
  });
  const cross = await asService(b, () => findPersonByLinkedinUrl("linkedin.com/in/fay-cross"));
  assert.equal(cross, null);
});

test("a later fetch from LinkedIn keeps the member's values and stamps, and fills the fields the member left empty", async () => {
  const [a] = await createTwoWorkspaces();
  const member = await memberOf(a);
  const body = {
    linkedinUrl: "https://linkedin.com/in/gus-later",
    firstName: "Gus",
    title: "VP Data",
    locationText: "Berlin, Germany",
  };
  const added = (await add(a, member, body)).body;

  const later = new Date(Date.now() + 3_600_000);
  const fresh = { ...profile("gus-later"), title: "Analyst", locationText: "Paris, France" };
  await asService(a, () =>
    upsertPersonFromSource({
      source: "linkedin",
      provider: "unipile",
      profile: { ...fresh, fetchedAt: later },
    }),
  );
  const { person } = (await call(a, member, added.person.id)).body;
  assert.deepEqual(
    [person.firstName, person.title, person.locationText, person.locationCountry],
    ["Gus", "VP Data", "Berlin, Germany", "DE"],
  );
  for (const field of ["linkedinUrl", "firstName", "title", "locationText", "locationCountry"]) {
    assert.deepEqual(person.provenance[field], added.person.provenance[field], field);
  }
  assert.deepEqual(
    [person.lastName, person.headline, person.companyName],
    ["Example", "Data leader at a software company", "Blue Harbor Labs"],
  );
  const filled = { source: "linkedin", provider: "unipile", at: later.toISOString() };
  for (const field of ["lastName", "headline", "companyName"]) {
    assert.deepEqual(person.provenance[field], filled, field);
  }
});

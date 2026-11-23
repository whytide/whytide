// enrichment's lead routes end to end (gamma-en-055; core/modules/enrichment/README.md "The lead
// page"): the host started with identity, contacts and enrichment, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP; a write sends the app's
// Origin and an Idempotency-Key. A person and the company contacts' upsertCompany writes for a
// source of each class, a field a member set, the person's country; another workspace's person.
// The read answers each field with its value, class and time, an empty one null, and never a
// provider's name; the request writes one run and one event per key. No route calls a vendor:
// the run itself is the worker's (core/apps/worker/tests/enrichment-run.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import {
  linkPersonToCompany,
  recordPersonCountry,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, tenantClient, withTenant } from "@whytide/db";
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

// enrichment by its build's path, as src/modules.generated.ts loads it.
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
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
      { name: "enrichment", load: () => import(built("enrichment/dist")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; replayed: string | null; body: any };
/** The providers that stamp the seeded values: none may reach an answer. */
const PROVIDERS = ["wikidata", "pdl", "unipile"];
const AT = { open: "2026-11-10T08:00:00.000Z", vendor: "2026-11-11T09:30:00.000Z" };

/** A request to …/enrichment/leads/<personId> of the workspace as the user; a POST with `key`. */
async function send(
  user: string,
  workspaceId: string,
  method: "GET" | "POST",
  personId: string,
  key: string | null = randomUUID(),
): Promise<Answer> {
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const write = method === "GET" ? {} : { origin: APP_ORIGIN };
  const idempotent = method === "POST" && key !== null ? { "idempotency-key": key } : {};
  const headers = { cookie: cookie.join("; "), ...write, ...idempotent };
  const url = new URL(`/v1/workspaces/${workspaceId}/enrichment/leads/${personId}`, api.url);
  const res = await fetch(url, { method, headers });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: await res.json(),
  };
}
const codeOf = ({ status, body }: Answer) => [status, body.code];

/**
 * The tenant's workspace with a Member, and a person whose company has a domain and a page from
 * open data, an industry and a size from a data vendor, a description a member set, and no
 * country; the person's country from open data. With `bare`, a person with no company too.
 */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const principal = servicePrincipal("enrichment_test");
  const inTenant = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const ids = await inTenant(async () => {
    const person = async (slug: string) => {
      const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID()}`;
      const profile = { linkedinUrl, firstName: "Ana", companyName: "Corvid" };
      const source = { source: "linkedin", provider: "unipile", profile } as const;
      return (await upsertPersonFromSource(source)).person.id;
    };
    const personId = await person("ana");
    const bareId = await person("bare");
    const facts = {
      name: "Corvid",
      domain: "corvid.test",
      linkedinUrl: "https://linkedin.com/company/corvid",
    };
    const open = { ...facts, fetchedAt: new Date(AT.open) };
    const { company } = await upsertCompany({
      source: "open_data",
      provider: "wikidata",
      company: open,
    });
    const vendor = { ...facts, industry: "Logistics", sizeRange: "51-200", employeeCount: 120 };
    const fetchedAt = new Date(AT.vendor);
    await upsertCompany({
      source: "data_vendor",
      provider: "pdl",
      company: { ...vendor, fetchedAt },
    });
    // A member's own value, as contacts will keep one on the organization's row of the company
    // (gamma-rf-010; no command writes one yet): the class `member`, no provider.
    const { companyId } = await tenantClient.workspaceCompany.findFirstOrThrow({
      where: { id: company.id },
    });
    const memberAt = "2026-11-12T10:00:00.000Z";
    const memberStamp = { description: { source: "member", provider: null, at: memberAt } };
    const written = await tenantClient.$executeRaw`
      INSERT INTO group_companies (sharing_group_id, company_id, description, field_provenance,
        updated_at)
      VALUES (${tenant.organization.id}, ${companyId}, 'Parcels for small shops, by bike.',
        ${JSON.stringify(memberStamp)}::jsonb, now())
      ON CONFLICT (sharing_group_id, company_id) DO UPDATE
      SET description = EXCLUDED.description,
        field_provenance = group_companies.field_provenance || EXCLUDED.field_provenance`;
    assert.equal(written, 1);
    await linkPersonToCompany({ personId, companyId: company.id });
    const stamp = { source: "open_data", provider: "wikidata", at: new Date(AT.open) } as const;
    await recordPersonCountry({ personId, country: "DE", stamp });
    return { personId, bareId, memberAt };
  });
  return {
    ...ids,
    workspaceId,
    owner: (method: "GET" | "POST", personId: string, key?: string | null) =>
      send(tenant.user.id, workspaceId, method, personId, key),
    member: (method: "GET" | "POST", personId: string, key?: string | null) =>
      send(member.id, workspaceId, method, personId, key),
  };
}

/** The workspace's runs and its enrichment.run_requested events' payloads. */
async function written(workspaceId: string) {
  const runs = await app.enrichmentRun.findMany({
    where: { workspaceId },
    select: { id: true, personId: true, trigger: true, status: true, requestKey: true },
  });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "enrichment.run_requested" },
    select: { payload: true },
  });
  return { runs, events: events.map(({ payload }) => payload) };
}

test("GET …/enrichment/leads/{personId}: each company field with its value, class and time, in order, an empty one null, a member's value with class member; the person's country; no run yet; no provider's name anywhere", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const read = await seed.member("GET", seed.personId);

  assert.equal(read.status, 200);
  const open = { sourceClass: "open_data", at: AT.open };
  const vendor = { sourceClass: "data_vendor", at: AT.vendor };
  assert.deepEqual(read.body, {
    company: {
      name: "Corvid",
      fields: [
        { field: "domain", value: "corvid.test", ...open },
        { field: "linkedinUrl", value: "https://linkedin.com/company/corvid", ...open },
        { field: "industry", value: "Logistics", ...vendor },
        { field: "sizeRange", value: "51-200", ...vendor },
        { field: "employeeCount", value: 120, ...vendor },
        { field: "country", value: null, sourceClass: null, at: null },
        {
          field: "description",
          value: "Parcels for small shops, by bike.",
          ...{ sourceClass: "member", at: seed.memberAt },
        },
      ],
    },
    person: { country: { value: "DE", ...open } },
    lastRun: null,
  });
  const text = JSON.stringify(read.body);
  for (const provider of PROVIDERS) assert.equal(text.includes(provider), false, provider);
  assert.equal(text.includes("provider"), false);

  const bare = await seed.owner("GET", seed.bareId);
  assert.deepEqual(bare.body, { company: null, person: { country: null }, lastRun: null });
});

test("POST …/enrichment/leads/{personId}: 202 with the queued run; the key again answers the same run, replayed, one run and one event; another key another run; GET then answers the last run", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const key = randomUUID();

  const first = await seed.member("POST", seed.personId, key);
  assert.equal(first.status, 202);
  assert.match(first.body.runId, /^erun_/);
  assert.deepEqual(first.body, { runId: first.body.runId, status: "queued" });
  const again = await seed.member("POST", seed.personId, key);
  assert.deepEqual([again.status, again.replayed, again.body], [202, "true", first.body]);
  const { runs, events } = await written(seed.workspaceId);
  assert.deepEqual(runs, [
    {
      ...{ id: first.body.runId, personId: seed.personId, trigger: "request", status: "queued" },
      requestKey: `request:${key}`,
    },
  ]);
  assert.deepEqual(events, [{ runId: first.body.runId }]);

  const other = await seed.owner("POST", seed.personId);
  assert.equal(other.status, 202);
  assert.notEqual(other.body.runId, first.body.runId);
  assert.equal((await written(seed.workspaceId)).events.length, 2);

  // The newest run is the last: what its sources answered, each once, in order, never a source.
  const tried = [
    { source: "company-data/wikidata", outcome: "found", code: null, filled: ["country"], ms: 5 },
    { source: "web-search", outcome: "ambiguous", code: null, filled: [], ms: 7 },
    { source: "company-data/pdl", outcome: "found", code: null, filled: [], ms: 3 },
  ];
  await app.enrichmentRun.update({
    where: { id: other.body.runId },
    data: {
      ...{ status: "done", filled: ["country"], sourcesTried: tried },
      finishedAt: new Date(AT.vendor),
    },
  });
  const read = await seed.owner("GET", seed.personId);
  assert.deepEqual(read.body.lastRun, {
    ...{ runId: other.body.runId, trigger: "request", status: "done" },
    ...{ filled: ["country"], outcomes: ["found", "ambiguous"], finishedAt: AT.vendor },
  });
  const text = JSON.stringify(read.body);
  for (const name of [...PROVIDERS, "company-data", "web-search"]) {
    assert.equal(text.includes(name), false, name);
  }
});

test("refused, nothing written: no Idempotency-Key 400; another workspace's person and an unknown one 404 enrichment_person_not_found, to the GET and the POST; a user of another workspace 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);

  assert.deepEqual(codeOf(await seed.owner("POST", seed.personId, null)), [
    400,
    "idempotency_key_required",
  ]);
  const notFound = [404, "enrichment_person_not_found"];
  for (const method of ["GET", "POST"] as const) {
    assert.deepEqual(codeOf(await seed.owner(method, theirs.personId)), notFound);
    assert.deepEqual(codeOf(await seed.owner(method, "per_unknown")), notFound);
    // b's Owner is no member of a's workspace: the workspace guard refuses before the route.
    const forbidden = await send(b.user.id, seed.workspaceId, method, seed.personId);
    assert.deepEqual(codeOf(forbidden), [403, "forbidden"]);
  }
  assert.deepEqual(await written(seed.workspaceId), { runs: [], events: [] });
  assert.deepEqual(await written(theirs.workspaceId), { runs: [], events: [] });
});

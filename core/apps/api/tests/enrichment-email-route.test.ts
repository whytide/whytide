// enrichment's Email panel routes end to end (gamma-en-081; core/modules/enrichment/README.md "The
// Email panel"): the host started with identity, contacts and enrichment, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP; a write sends the app's
// Origin and an Idempotency-Key. Persons with a held work address, a held personal one of a lead with
// no known country, and a lookup that ended without an address, written as a settle leaves them,
// each stamped with a provider's name and steps naming finders and verifiers; another workspace's
// person. The read answers the address, its kind, verification, class and times, and the last
// lookup, never a provider's or a source's name; "find" and "verify" write one request and one event
// per key. No route calls a vendor: the lookup itself is the worker's
// (core/apps/worker/tests/enrichment-lookup.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { recordPersonCountry, upsertPersonFromSource } from "@whytide/contacts";
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
/** The finders', verifiers' and sources' names the seeded rows carry: none may reach an answer. */
const NAMES = ["hunter", "zerobounce", "email-finder", "email-verifier", "test-reply"];
const AT = {
  verified: "2026-11-10T08:00:00.000Z",
  acquired: "2026-11-09T07:00:00.000Z",
  ended: "2026-11-12T09:30:00.000Z",
};

/** A request to …/enrichment/leads/<personId>/work-email as the user; a POST with `key` and `body`. */
async function send(
  user: string,
  workspaceId: string,
  method: "GET" | "POST",
  personId: string,
  options: { key?: string | null; body?: unknown } = {},
): Promise<Answer> {
  const { key = randomUUID(), body } = options;
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const write = method === "GET" ? {} : { origin: APP_ORIGIN, "content-type": "application/json" };
  const idempotent = method === "POST" && key !== null ? { "idempotency-key": key } : {};
  const headers = { cookie: cookie.join("; "), ...write, ...idempotent };
  const path = `/v1/workspaces/${workspaceId}/enrichment/leads/${personId}/work-email`;
  const init = method === "POST" ? { body: JSON.stringify(body ?? { action: "find" }) } : {};
  const res = await fetch(new URL(path, api.url), { method, headers, ...init });
  return {
    status: res.status,
    replayed: res.headers.get("idempotent-replayed"),
    body: await res.json(),
  };
}
const codeOf = ({ status, body }: Answer) => [status, body.code];

/**
 * The tenant's workspace with a Member, and three persons: Ana, a US lead, with a work address an
 * email finder found and a lookup that found it; Bea, with no known country, with a personal
 * address she gave; Cal, whose lookup ended waiting for a verifier, holding none.
 */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const principal = servicePrincipal("enrichment_test");
  const inTenant = <T>(fn: () => Promise<T>) =>
    withTenant({ workspaceId, principal }, fn, { client: app });
  const ids = await inTenant(async () => {
    const person = async (slug: string, firstName: string) => {
      const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID()}`;
      const profile = { linkedinUrl, firstName, companyName: "Corvid" };
      const source = { source: "linkedin", provider: "unipile", profile } as const;
      return (await upsertPersonFromSource(source)).person.id;
    };
    const [ana, bea, cal] = [
      await person("ana", "Ana"),
      await person("bea", "Bea"),
      await person("cal", "Cal"),
    ];
    const stamp = { source: "open_data", provider: "wikidata", at: new Date(AT.verified) } as const;
    await recordPersonCountry({ personId: ana, country: "US", stamp });
    const suffix = randomUUID().slice(0, 8);
    const point = async (personId: string, value: string, kind: string, sourceClass: string) => {
      const id = `cp_${randomUUID().replaceAll("-", "")}`;
      await tenantClient.contactPoint.create({
        data: {
          ...{ id, workspaceId, personId, value, verification: "valid" },
          kind: kind as "work_email" | "personal_email",
          ...{ sourceClass, provider: sourceClass === "email_finder" ? "hunter" : "test-reply" },
          verifiedAt: new Date(AT.verified),
          acquiredAt: new Date(AT.acquired),
          legalBasis: "legitimate_interest",
        },
      });
      return id;
    };
    const anaPoint = await point(ana, `ana.${suffix}@corvid.test`, "work_email", "email_finder");
    await point(bea, `bea.${suffix}@gmail.example`, "personal_email", "lead_reply");
    const request = async (personId: string, end: object) => {
      const id = `enr_${randomUUID().replaceAll("-", "")}`;
      const providersTried = [
        { source: "email-finder/hunter", step: "find", outcome: "found", code: null, ms: 5 },
        {
          source: "email-verifier/zerobounce",
          step: "verify",
          outcome: "valid",
          code: null,
          ms: 7,
        },
      ];
      await tenantClient.enrichmentRequest.create({
        data: {
          ...{ id, workspaceId, personId, trigger: "jit_step", requestKey: `step:${id}` },
          ...{ providersTried, finishedAt: new Date(AT.ended), ...end },
        },
      });
      return id;
    };
    const anaRequest = await request(ana, { status: "found", contactPointId: anaPoint });
    const calRequest = await request(cal, {
      ...{ status: "waiting_allowance", reason: "no_verifier_left", errorCode: "zerobounce_down" },
    });
    return { ana, bea, cal, anaRequest, calRequest };
  });
  const as =
    (user: string) =>
    (method: "GET" | "POST", personId: string, options?: { key?: string | null; body?: unknown }) =>
      send(user, workspaceId, method, personId, options);
  return { ...ids, workspaceId, owner: as(tenant.user.id), member: as(member.id) };
}

/** The workspace's requests but the seeded ones, and its enrichment.lookup_requested events' payloads. */
async function written(workspaceId: string) {
  const requests = await app.enrichmentRequest.findMany({
    where: { workspaceId, NOT: { requestKey: { startsWith: "step:" } } },
    select: { id: true, personId: true, trigger: true, status: true, requestKey: true },
    orderBy: { createdAt: "asc" },
  });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "enrichment.lookup_requested" },
    select: { payload: true },
  });
  return { requests, events: events.map(({ payload }) => payload) };
}

const noNames = (body: unknown) => {
  const text = JSON.stringify(body);
  for (const name of NAMES) assert.equal(text.includes(name), false, name);
  assert.equal(text.includes("provider"), false);
};

test("GET …/leads/{personId}/work-email: a held work address with its kind, verification, class and times, and the lookup that found it; a personal address of a lead with no known country, needsConsent; a lookup ended without an address, its reason; none at all, both null; no provider's or source's name anywhere", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);

  const ana = await seed.member("GET", seed.ana);
  assert.equal(ana.status, 200);
  assert.deepEqual(ana.body, {
    email: {
      address: ana.body.email.address,
      kind: "work_email",
      verification: "valid",
      sourceClass: "email_finder",
      verifiedAt: AT.verified,
      acquiredAt: AT.acquired,
      needsConsent: false,
    },
    lastLookup: {
      requestId: seed.anaRequest,
      trigger: "jit_step",
      status: "found",
      reason: null,
      finishedAt: AT.ended,
    },
  });
  assert.match(ana.body.email.address, /^ana\.[0-9a-f]{8}@corvid\.test$/);
  noNames(ana.body);

  const bea = await seed.member("GET", seed.bea);
  assert.deepEqual(
    [bea.body.email.kind, bea.body.email.sourceClass, bea.body.email.needsConsent],
    ["personal_email", "lead_reply", true],
  );
  assert.equal(bea.body.lastLookup, null);
  noNames(bea.body);

  const cal = await seed.owner("GET", seed.cal);
  assert.deepEqual(cal.body, {
    email: null,
    lastLookup: {
      requestId: seed.calRequest,
      trigger: "jit_step",
      status: "waiting_allowance",
      reason: "no_verifier_left",
      finishedAt: AT.ended,
    },
  });
  noNames(cal.body);
});

test("POST …/work-email: find, 202 with the queued request; the key again answers the same request, replayed, one request and one event; another key while it is queued or running answers it too, writing none (no second reservation), as does a press during the email step's lookup; once it ended, another key another request; verify, a re-verification under its own key; GET then answers the newest", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const key = randomUUID();

  const first = await seed.member("POST", seed.cal, { key, body: { action: "find" } });
  assert.equal(first.status, 202);
  assert.match(first.body.requestId, /^enr_/);
  assert.deepEqual(first.body, { requestId: first.body.requestId, status: "queued" });
  const again = await seed.member("POST", seed.cal, { key, body: { action: "find" } });
  assert.deepEqual([again.status, again.replayed, again.body], [202, "true", first.body]);
  const found = { personId: seed.cal, status: "queued" };
  assert.deepEqual((await written(seed.workspaceId)).requests, [
    { id: first.body.requestId, ...found, trigger: "request", requestKey: `request:${key}` },
  ]);
  assert.deepEqual((await written(seed.workspaceId)).events, [{ requestId: first.body.requestId }]);

  // Another tab or member: the queued request answers, then the running one; nothing written.
  const twice = await seed.owner("POST", seed.cal, { body: { action: "find" } });
  assert.deepEqual([twice.status, twice.replayed, twice.body], [202, null, first.body]);
  await app.enrichmentRequest.update({
    where: { id: first.body.requestId },
    data: { status: "running" },
  });
  const running = await seed.member("POST", seed.cal, { body: { action: "verify" } });
  assert.deepEqual(running.body, { requestId: first.body.requestId, status: "running" });
  assert.equal((await written(seed.workspaceId)).requests.length, 1);
  assert.equal((await written(seed.workspaceId)).events.length, 1);
  // A press during the email step's lookup answers the step's request.
  const step = await app.enrichmentRequest.create({
    data: {
      ...{ id: `enr_${randomUUID().replaceAll("-", "")}`, workspaceId: seed.workspaceId },
      ...{ personId: seed.bea, trigger: "jit_step", requestKey: `step:${randomUUID()}` },
    },
  });
  const during = await seed.member("POST", seed.bea, { body: { action: "find" } });
  assert.deepEqual(during.body, { requestId: step.id, status: "queued" });

  // Ended: the next press writes a new request.
  await app.enrichmentRequest.update({
    where: { id: first.body.requestId },
    data: { status: "not_found", reason: "no_result", finishedAt: new Date() },
  });
  const verifyKey = randomUUID();
  const verify = await seed.owner("POST", seed.ana, {
    key: verifyKey,
    body: { action: "verify" },
  });
  assert.equal(verify.status, 202);
  assert.deepEqual(verify.body, { requestId: verify.body.requestId, status: "queued" });
  const other = await seed.member("POST", seed.cal, { body: { action: "find" } });
  assert.notEqual(other.body.requestId, first.body.requestId);
  const { requests, events } = await written(seed.workspaceId);
  assert.deepEqual(
    requests.map(({ id, trigger, requestKey }) => [id, trigger, requestKey]),
    [
      [first.body.requestId, "request", `request:${key}`],
      [verify.body.requestId, "reverify", `reverify:${verifyKey}`],
      [other.body.requestId, "request", requestKeyOf(requests, other.body.requestId)],
    ],
  );
  assert.equal(events.length, 3);

  const read = await seed.member("GET", seed.cal);
  assert.deepEqual(read.body.lastLookup, {
    requestId: other.body.requestId,
    trigger: "request",
    status: "queued",
    reason: null,
    finishedAt: null,
  });
  const ana = await seed.member("GET", seed.ana);
  assert.deepEqual(
    [ana.body.lastLookup.requestId, ana.body.lastLookup.trigger, ana.body.email.kind],
    [verify.body.requestId, "reverify", "work_email"],
  );
});

test("refused, nothing written: no Idempotency-Key 400; a body with no action or another 400; another workspace's person and an unknown one 404 enrichment_person_not_found, to the GET and the POST; a user of another workspace 403; the same key with the other action 422", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);

  assert.deepEqual(codeOf(await seed.owner("POST", seed.cal, { key: null })), [
    400,
    "idempotency_key_required",
  ]);
  for (const body of [{}, { action: "guess" }, { action: "find", extra: 1 }]) {
    assert.deepEqual(codeOf(await seed.owner("POST", seed.cal, { body })), [
      400,
      "validation_failed",
    ]);
  }
  const notFound = [404, "enrichment_person_not_found"];
  for (const method of ["GET", "POST"] as const) {
    assert.deepEqual(codeOf(await seed.owner(method, theirs.ana)), notFound);
    assert.deepEqual(codeOf(await seed.owner(method, "per_unknown")), notFound);
    // b's Owner is no member of a's workspace: the workspace guard refuses before the route.
    const forbidden = await send(b.user.id, seed.workspaceId, method, seed.ana);
    assert.deepEqual(codeOf(forbidden), [403, "forbidden"]);
  }
  assert.deepEqual(await written(seed.workspaceId), { requests: [], events: [] });
  assert.deepEqual(await written(theirs.workspaceId), { requests: [], events: [] });

  const key = randomUUID();
  assert.equal((await seed.owner("POST", seed.ana, { key, body: { action: "find" } })).status, 202);
  const reused = await seed.owner("POST", seed.ana, { key, body: { action: "verify" } });
  assert.deepEqual(codeOf(reused), [422, "idempotency_key_reused"]);
  assert.equal((await written(seed.workspaceId)).requests.length, 1);
});

function requestKeyOf(requests: { id: string; requestKey: string }[], id: string): string {
  const key = requests.find((request) => request.id === id)?.requestKey ?? "";
  assert.match(key, /^request:[0-9a-f-]{36}$/);
  return key;
}

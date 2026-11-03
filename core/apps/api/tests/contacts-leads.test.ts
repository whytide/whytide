// contacts' lead routes end to end (alpha-p5-020, the counts alpha-p6-050, the neighbours alpha-p6-060,
// the lead's suppression beta-p2-020; core/modules/contacts/README.md "Routes"): the host started
// with identity, whose resolver guards the workspace, and contacts, mounted under
// /v1/workspaces/:workspaceId/contacts, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP. It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  addOptOut,
  applyQualification,
  createLeadForPerson,
  recordTouch,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

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
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const fetchedAt = new Date("2026-10-01T08:00:00Z");
type Decision = Omit<Parameters<typeof applyQualification>[0], "personId">;
/** In the tenant's workspace, as an import or a worker writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** A person of the tenant's workspace and its lead, written as an import and qualification do. */
const seed = ({ workspace }: TestTenant, slug: string, decision?: Decision) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("contacts_test") },
    async () => {
      const linkedinUrl = `https://linkedin.com/in/${slug}`;
      const profile = { linkedinUrl, firstName: "Elif", lastName: slug, title: "Head of Data" };
      const fields = { ...profile, companyName: "Blue Harbor Labs", fetchedAt };
      const source = { source: "import", provider: "csv", profile: fields } as const;
      const { person } = await upsertPersonFromSource(source);
      const personId = person.id;
      await createLeadForPerson({
        personId,
        source: { kind: "imported", ref: "imp_1", at: fetchedAt },
      });
      if (decision) await applyQualification({ personId, ...decision });
      return person;
    },
    { client: asRole("app") },
  );

/** GET …/contacts/<path> of the workspace, signed in as the user. */
async function get(workspaceId: string, path: string, userId: string) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const url = new URL(`/v1/workspaces/${workspaceId}/contacts/${path}`, api.url);
  const res = await fetch(url, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
type Row = { personId: string; [field: string]: unknown };
const rows = (body: Record<string, unknown>) => body.leads as Row[];
const ids = (body: Record<string, unknown>) => rows(body).map((lead) => lead.personId);

test("GET …/contacts/leads?sort=fit answers qualified leads by descending fit with the person's business fields; status and tier filter; …/leads/{personId} answers one, 404 for another workspace's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const why = [{ key: "qualification.why.fit", params: { title: "Head of Data" } }];
  const hot = await seed(a, "elif-hot", {
    status: "qualified",
    fitScore: 90,
    confidence: "high",
    tier: "hot",
    why,
  });
  const warm = await seed(a, "elif-warm", {
    status: "qualified",
    fitScore: 70,
    confidence: "medium",
    tier: "warm",
  });
  const cool = await seed(a, "elif-cool", {
    status: "not_qualified",
    fitScore: 40,
    confidence: "low",
    tier: "cool",
    reason: "recruiter",
  });
  const pending = await seed(a, "elif-pending");
  const theirs = await seed(b, "elif-hot", { status: "qualified", fitScore: 95, tier: "hot" });
  const user = a.user.id;
  const ws = a.workspace.id;

  const qualified = await get(ws, "leads?sort=fit&status=qualified", user);
  assert.deepEqual([qualified.status, ids(qualified.body)], [200, [hot.id, warm.id]]);
  const [first] = rows(qualified.body);
  assert.deepEqual(first?.person, {
    firstName: "Elif",
    lastName: "elif-hot",
    title: "Head of Data",
    companyName: "Blue Harbor Labs",
    companyId: null,
    linkedinUrl: "https://linkedin.com/in/elif-hot",
  });
  const { qualificationStatus, fitScore, fitConfidence, tier, sourceLabel } = first ?? {};
  assert.deepEqual(
    [qualificationStatus, fitScore, fitConfidence, tier, sourceLabel, first?.why],
    ["qualified", 90, "high", "hot", "imported", why],
  );
  const everyone = await get(ws, "leads?sort=fit", user);
  assert.deepEqual(ids(everyone.body), [hot.id, warm.id, cool.id, pending.id], "no score last");
  assert.deepEqual(ids((await get(ws, "leads?tier=hot", user)).body), [hot.id]);
  assert.deepEqual(ids((await get(ws, "leads?status=pending", user)).body), [pending.id]);
  assert.deepEqual(ids((await get(ws, "leads?status=not_qualified&tier=cool", user)).body), [
    cool.id,
  ]);

  const one = await get(ws, `leads/${hot.id}`, user);
  const person = one.body.person as Record<string, unknown>;
  const stamp = { source: "import", provider: "csv", at: fetchedAt.toISOString() };
  assert.deepEqual(
    [one.status, one.body.personId, one.body.tier, person.id, person.headline],
    [200, hot.id, "hot", hot.id, null],
  );
  assert.deepEqual(one.body.sources, [
    { kind: "imported", ref: "imp_1", at: fetchedAt.toISOString() },
  ]);
  assert.deepEqual((person.provenance as Record<string, unknown>).title, stamp);
  assert.equal("workspaceId" in one.body || "providerRefs" in person, false);
  assert.deepEqual(await get(ws, `leads/${theirs.id}`, user), {
    status: 404,
    body: { code: "lead_not_found" },
  });
  const malformed = await get(ws, "leads?cursor=not-a-cursor", user);
  assert.deepEqual(malformed, {
    status: 400,
    body: { code: "contacts_input_invalid", details: { fields: ["cursor"] } },
  });
});

test("GET …/contacts/leads/{personId} answers suppression null, a recent touch aside, then the reason once the person opts out", async () => {
  const [a] = await createTwoWorkspaces();
  const person = await seed(a, "suki-stop", { status: "qualified", fitScore: 80, tier: "hot" });
  const read = async () => {
    const { status, body } = await get(a.workspace.id, `leads/${person.id}`, a.user.id);
    assert.equal(status, 200);
    return body.suppression;
  };
  assert.equal(await read(), null);
  // A touch refuses a new enrollment only: the lead's answer asks without one.
  await asService(a, () => recordTouch(person.id, new Date()));
  assert.equal(await read(), null);
  await asService(a, () => addOptOut(person.id, { source: "system", reason: "reply_opt_out" }));
  assert.deepEqual(await read(), { reason: "opted_out" });
});

test("GET …/contacts/leads/counts answers the workspace's leads per status, every status named, none of another workspace's", async () => {
  const [a, b] = await createTwoWorkspaces();
  await seed(a, "noor-hot", { status: "qualified", fitScore: 80, tier: "hot" });
  await seed(a, "noor-warm", { status: "qualified", fitScore: 70, tier: "warm" });
  await seed(a, "noor-gap", { status: "needs_review", fitScore: 65, tier: "warm" });
  await seed(a, "noor-new");
  await seed(b, "noor-hot", { status: "qualified", fitScore: 90, tier: "hot" });
  await seed(b, "noor-failed", { status: "ai_failed", reason: "invalid" });
  const counts = { pending: 1, hard_filtered: 0, qualified: 2, not_qualified: 0, needs_review: 1 };
  assert.deepEqual(await get(a.workspace.id, "leads/counts", a.user.id), {
    status: 200,
    body: { counts: { ...counts, ai_failed: 0 } },
  });
});

test("GET …/contacts/leads/{personId}/neighbours answers the leads just before and after one in the list's view, none of another workspace's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const top = await seed(a, "ada-top", { status: "qualified", fitScore: 90, tier: "hot" });
  const middle = await seed(a, "ada-middle", { status: "qualified", fitScore: 70, tier: "warm" });
  const low = await seed(a, "ada-low", { status: "qualified", fitScore: 50, tier: "cool" });
  const review = await seed(a, "ada-review", { status: "needs_review", fitScore: 80, tier: "hot" });
  await seed(b, "ada-theirs", { status: "qualified", fitScore: 80, tier: "hot" });
  const around = async (personId: string, query: string) =>
    (await get(a.workspace.id, `leads/${personId}/neighbours?${query}`, a.user.id)).body;
  const qualified = "status=qualified&sort=";
  assert.deepEqual(await around(middle.id, `${qualified}fit`), { previous: top.id, next: low.id });
  assert.deepEqual(await around(top.id, `${qualified}fit`), { previous: null, next: middle.id });
  // Newest first: the leads were made in the order above.
  const newest = { previous: low.id, next: top.id };
  assert.deepEqual(await around(middle.id, `${qualified}newest`), newest);
  assert.deepEqual(await around(middle.id, "sort=fit"), { previous: review.id, next: low.id });
  assert.deepEqual(await get(b.workspace.id, `leads/${middle.id}/neighbours`, b.user.id), {
    status: 404,
    body: { code: "lead_not_found" },
  });
});

test("the cursor pages through 1,000 leads without gaps or repeats, by fit, by newest and unreviewed first, whatever the ties", async () => {
  const [{ workspace, user }] = await createTwoWorkspaces();
  const app = asRole("app");
  const base = Date.parse("2026-10-01T08:00:00.123Z");
  // Digits after one prefix, so that the database and JavaScript order the ids alike.
  const people = Array.from({ length: 1000 }, (_, i) => ({
    personId: `per_t${String(i).padStart(4, "0")}`,
    // About ten leads per score, and every ninth without one.
    fitScore: i % 9 === 0 ? null : (i * 7) % 101,
    // Twenty-five leads per instant.
    createdAt: new Date(base + Math.floor(i / 25) * 1000),
    // A third without a decision, a third good, a third not a fit.
    reviewStatus: ([null, "good_lead", "not_a_fit"] as const)[i % 3] ?? null,
  }));
  await app.person.createMany({
    data: people.map(({ personId }) => ({
      id: personId,
      workspaceId: workspace.id,
      linkedinUrl: `https://linkedin.com/in/${personId.replace("_", "-")}`,
      fieldProvenance: {},
    })),
  });
  await app.lead.createMany({
    data: people.map((lead) => ({
      ...lead,
      workspaceId: workspace.id,
      qualificationStatus: lead.fitScore === null ? "pending" : "qualified",
      sourceLabel: "imported",
      sources: [],
      firstSourceAt: lead.createdAt,
    })),
  });
  const desc = (x: string, y: string) => (x < y ? 1 : x > y ? -1 : 0);
  const rank = (review: string | null) => (review === null ? 0 : review === "good_lead" ? 1 : 2);
  const expected = {
    fit: [...people]
      .sort((x, y) => (y.fitScore ?? -1) - (x.fitScore ?? -1) || desc(x.personId, y.personId))
      .map((lead) => lead.personId),
    newest: [...people]
      .sort((x, y) => +y.createdAt - +x.createdAt || desc(x.personId, y.personId))
      .map((lead) => lead.personId),
    unreviewed_first: [...people]
      .sort(
        (x, y) =>
          rank(x.reviewStatus) - rank(y.reviewStatus) ||
          (y.fitScore ?? -1) - (x.fitScore ?? -1) ||
          desc(x.personId, y.personId),
      )
      .map((lead) => lead.personId),
  };
  for (const sort of ["fit", "newest", "unreviewed_first"] as const) {
    const seen: string[] = [];
    let cursor: unknown = "";
    for (let page = 0; cursor !== null && page < 20; page++) {
      const after = cursor === "" ? "" : `&cursor=${cursor}`;
      const { status, body } = await get(
        workspace.id,
        `leads?sort=${sort}&limit=100${after}`,
        user.id,
      );
      assert.equal(status, 200);
      seen.push(...ids(body));
      cursor = body.nextCursor;
    }
    assert.equal(new Set(seen).size, 1000, `${sort}: no repeat`);
    assert.deepEqual(seen, expected[sort], `${sort}: every lead, in order`);
  }
});

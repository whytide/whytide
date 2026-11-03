// contacts' review routes end to end (alpha-p9-040; core/modules/contacts/README.md "Routes"): the
// host started with identity, whose resolver guards the workspace, and contacts, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. It lives
// here: a module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { applyQualification, createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
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

const DAY = 86_400_000;
type Qualified = Omit<Parameters<typeof applyQualification>[0], "personId">;
/** In the tenant's workspace, as qualification writes. */
const asService = <T>({ workspace }: TestTenant, fn: () => Promise<T>) =>
  withTenant({ workspaceId: workspace.id, principal: servicePrincipal("contacts_test") }, fn, {
    client: asRole("app"),
  });
/** A person of the tenant's workspace and its lead, qualified as given. */
const seed = (tenant: TestTenant, slug: string, decision: Qualified) =>
  asService(tenant, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Rae" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    await applyQualification({ personId: person.id, ...decision });
    return person;
  });

type Answer = { status: number; body: any };
/** A call to …/contacts/<path> in the tenant's workspace, as its Owner, from the app. */
async function call(tenant: TestTenant, method: string, path: string, body?: unknown) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, origin: APP_ORIGIN };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/contacts/${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined } as Answer;
}
const review = (tenant: TestTenant, personId: string, body: object) =>
  call(tenant, "POST", `leads/${personId}/review`, body);
const ids = ({ body }: Answer) => body.leads.map((lead: { personId: string }) => lead.personId);

test("POST …/leads/{personId}/review: Not a fit without a code is review_reason_required, Other or Good lead without words review_text_required; a decision stores the lead's snapshot, fit and tier of its time", async () => {
  const [a, b] = await createTwoWorkspaces();
  const qualified = {
    status: "qualified",
    fitScore: 82,
    tier: "hot",
    snapshotId: "qsn_1",
  } as const;
  const lead = await seed(a, "rae-hot", qualified);
  const refused = (code: string, details?: object) => ({
    status: 400,
    body: details ? { code, details } : { code },
  });
  const answers = [
    [{ decision: "not_a_fit" }, refused("review_reason_required")],
    [{ decision: "not_a_fit", reasonCode: "other" }, refused("review_text_required")],
    [
      { decision: "not_a_fit", reasonCode: "other", reasonText: "  " },
      refused("review_text_required"),
    ],
    [{ decision: "good_lead" }, refused("review_text_required")],
    [
      { decision: "good_lead", goodReasonText: "Runs data", reasonCode: "bad_timing" },
      refused("contacts_input_invalid", { fields: ["reasonCode"] }),
    ],
  ] as const;
  for (const [body, answer] of answers)
    assert.deepEqual(await review(a, lead.id, body), answer, JSON.stringify(body));
  assert.equal(await asRole("app").reviewDecision.count({ where: { personId: lead.id } }), 0);

  const good = await review(a, lead.id, { decision: "good_lead", goodReasonText: " Runs data " });
  const { id, decidedAt, ...stored } = good.body;
  assert.equal(good.status, 201);
  assert.match(id, /^rvd_/);
  assert.ok(Math.abs(Date.parse(decidedAt) - Date.now()) < 60_000);
  assert.deepEqual(stored, {
    personId: lead.id,
    decision: "good_lead",
    reasonCode: null,
    reasonText: null,
    goodReasonText: "Runs data",
    snapshotId: "qsn_1",
    fitAtDecision: 82,
    tierAtDecision: "hot",
    decidedBy: a.user.id,
  });
  const theirs = await review(b, lead.id, { decision: "not_a_fit", reasonCode: "bad_timing" });
  assert.deepEqual(theirs, { status: 404, body: { code: "lead_not_found" } });
});

test("a second decision appends a row and becomes the lead's review_status, each with the values of its time; the history answers both; no route updates or deletes one; the list's review filter, its reason, its unreviewed-first sort and the neighbours follow it", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const top = await seed(a, "ade-top", { status: "qualified", fitScore: 90, tier: "hot" });
  const lead = await seed(a, "ade-reviewed", { status: "qualified", fitScore: 85, tier: "hot" });
  const low = await seed(a, "ade-low", { status: "qualified", fitScore: 70, tier: "warm" });
  const good = await review(a, lead.id, { decision: "good_lead", goodReasonText: "Runs data" });
  const rescored = {
    status: "qualified",
    fitScore: 80,
    tier: "warm",
    snapshotId: "qsn_2",
  } as const;
  await asService(a, () => applyQualification({ personId: lead.id, ...rescored }));
  const left = await review(a, lead.id, {
    decision: "not_a_fit",
    reasonCode: "contact_left_company",
  });
  assert.deepEqual([good.status, left.status], [201, 201]);

  const { body } = await call(a, "GET", `leads/${lead.id}/reviews`);
  const history = body.reviews.map((row: Record<string, unknown>) => [
    row.id,
    row.decision,
    row.reasonCode,
    row.snapshotId,
    row.fitAtDecision,
    row.tierAtDecision,
  ]);
  assert.deepEqual(history, [
    [left.body.id, "not_a_fit", "contact_left_company", "qsn_2", 80, "warm"],
    [good.body.id, "good_lead", null, null, 85, "hot"],
  ]);
  const one = (await call(a, "GET", `leads/${lead.id}`)).body;
  assert.deepEqual([one.reviewStatus, one.reviewedAt], ["not_a_fit", left.body.decidedAt]);
  const where = { workspaceId, eventName: "contacts.lead_reviewed" };
  const outbox = await asRole("app").outboxEntry.findMany({ where, orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    outbox.map((row) => row.payload),
    ["good_lead", "not_a_fit"].map((decision) => ({ workspaceId, personId: lead.id, decision })),
  );

  const paths = ["review", "reviews", `reviews/${good.body.id}`].map(
    (p) => `leads/${lead.id}/${p}`,
  );
  for (const method of ["PUT", "PATCH", "DELETE"])
    for (const path of paths)
      assert.equal((await call(a, method, path, {})).status, 404, `${method} ${path}`);
  assert.equal(await asRole("app").reviewDecision.count({ where: { personId: lead.id } }), 2);

  const all = await call(a, "GET", "leads?sort=fit");
  const columns = (answer: Answer) =>
    answer.body.leads.map((row: Record<string, unknown>) => [
      row.reviewStatus,
      row.reviewReasonCode,
    ]);
  assert.deepEqual(
    [ids(all), columns(all)],
    [
      [top.id, lead.id, low.id],
      [
        [null, null],
        ["not_a_fit", "contact_left_company"],
        [null, null],
      ],
    ],
  );
  assert.deepEqual(ids(await call(a, "GET", "leads?sort=fit&review=unreviewed")), [top.id, low.id]);
  // Unreviewed first, by fit, then the decided ones.
  const firsts = await call(a, "GET", "leads?sort=unreviewed_first");
  assert.deepEqual(ids(firsts), [top.id, low.id, lead.id]);
  const around = async (personId: string, query: string) =>
    (await call(a, "GET", `leads/${personId}/neighbours?${query}`)).body;
  assert.deepEqual(await around(top.id, "sort=fit"), { previous: null, next: lead.id });
  assert.deepEqual(await around(top.id, "sort=fit&review=unreviewed"), {
    previous: null,
    next: low.id,
  });
  assert.deepEqual(await around(low.id, "sort=unreviewed_first"), {
    previous: top.id,
    next: lead.id,
  });
  assert.deepEqual(await around(lead.id, "sort=unreviewed_first"), {
    previous: low.id,
    next: null,
  });
});

test("GET …/reviews/summary?week=2026-W40: twenty-five qualified leads of the week, twelve good among the top twenty by fit, answer rate 0.6 and the week's counts by reason", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const monday = Date.parse("2026-09-28T00:00:00Z");
  const id = (i: number) => `per_w${String(i).padStart(2, "0")}`;
  type Status = "qualified" | "not_qualified";
  const made = (personId: string, fitScore: number, at: number, status: Status = "qualified") => ({
    personId,
    fitScore,
    at,
    qualificationStatus: status,
  });
  // Fit 99 down to 75, made during the week; a higher fit not qualified, or made the week after,
  // stays out.
  const leads = [
    ...Array.from({ length: 25 }, (_, i) => made(id(i), 99 - i, monday + i * 3600_000)),
    made("per_wout", 100, monday, "not_qualified"),
    made("per_wnext", 100, monday + 7 * DAY),
  ];
  const app = asRole("app");
  await app.person.createMany({
    data: leads.map(({ personId }) => ({
      id: personId,
      workspaceId,
      linkedinUrl: `https://linkedin.com/in/${personId.replace("_", "-")}`,
      fieldProvenance: {},
    })),
  });
  await app.lead.createMany({
    data: leads.map(({ at, ...lead }) => ({
      ...lead,
      workspaceId,
      sourceLabel: "imported",
      sources: [],
      firstSourceAt: new Date(at),
      createdAt: new Date(at),
    })),
  });
  const good = { decision: "good_lead", goodReasonText: "Fits the ICP" };
  const notAFit = (reasonCode: string) => ({
    decision: "not_a_fit",
    reasonCode,
    reasonText: "Seen",
  });
  const decided = [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 21, 22, 23].map((i) => [i, good] as const),
    ...[12, 13, 14].map((i) => [i, notAFit("company_wrong_size")] as const),
    ...[15, 16].map((i) => [i, notAFit("contact_wrong_seniority")] as const),
    [23, notAFit("other")] as const,
  ];
  for (const [i, body] of decided) assert.equal((await review(a, id(i), body)).status, 201);
  // Back into the week, in their order; the decision made after is of the week the test runs in.
  const shift = `${Date.now() - (monday + 2 * DAY)} milliseconds`;
  await asRole("owner").$executeRaw`
    UPDATE review_decisions SET decided_at = decided_at - ${shift}::interval
    WHERE workspace_id = ${workspaceId}`;
  await review(a, id(24), notAFit("company_competitor"));

  const { status, body } = await call(a, "GET", "reviews/summary?week=2026-W40");
  const { byReason, ...counts } = body;
  assert.deepEqual(
    [status, counts],
    [
      200,
      {
        decided: 20,
        goodLeads: 14,
        notAFit: 6,
        top20: { count: 20, goodLeads: 12, reviewed: 17, rate: 0.6 },
      },
    ],
  );
  const named = Object.entries(byReason).filter(([, count]) => count !== 0);
  const expected = { company_wrong_size: 3, contact_wrong_seniority: 2, other: 1 };
  assert.deepEqual([Object.keys(byReason).length, Object.fromEntries(named)], [15, expected]);

  const theirs = (await call(b, "GET", "reviews/summary?week=2026-W40")).body;
  assert.deepEqual(
    [theirs.decided, theirs.top20],
    [0, { count: 0, goodLeads: 0, reviewed: 0, rate: null }],
  );
  const invalid = { code: "contacts_input_invalid", details: { fields: ["week"] } };
  assert.deepEqual(await call(a, "GET", "reviews/summary?week=2025-W53"), {
    status: 400,
    body: invalid,
  });
});

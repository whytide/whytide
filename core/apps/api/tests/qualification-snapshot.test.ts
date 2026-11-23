// qualification's snapshot read end to end (alpha-p6-060; core/modules/qualification/README.md
// "Routes"): the host started with identity, contacts and qualification, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP; the lead written by
// contacts' commands, its snapshot and verdicts as qualification's assessment and score leave them,
// and its intent row as the intent write leaves it (gamma-p5-065): `intent` null without one, else
// the row with each signal newest first and no source's creator; the audience the lead was judged
// against, by name (gamma-p5-050). It lives here: a module never imports a host.
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
import { type Api, start } from "../src/start.ts";

// qualification by its build's path, as src/modules.generated.ts loads it: the api lists it
// nowhere.
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

const SUMMARY = "A data leader at a mid-sized software company.";
/** Stored out of the criteria's order, as a database may return them. */
const VERDICTS = [
  { criterion: "must_haves", verdict: "unknown", evidence: "", weight: 20, points: 0.4 },
  { criterion: "title_function", verdict: "met", evidence: "Head of Data", weight: 30, points: 1 },
  { criterion: "seniority", verdict: "met", evidence: "Head of Data", weight: 15, points: 1 },
  {
    criterion: "company_size",
    verdict: "partially_met",
    evidence: "51-200",
    weight: 10,
    points: 0.5,
  },
  { criterion: "industry", verdict: "met", evidence: "Software", weight: 15, points: 1 },
  { criterion: "location", verdict: "not_met", evidence: "Lisbon", weight: 10, points: 0 },
] as const;
const ORDER = ["title_function", "seniority", "company_size", "industry", "location", "must_haves"];

const AUDIENCE = "Revenue leaders in Iberia";
/**
 * A person and its lead; with `scored`, a scored snapshot against an audience of the workspace,
 * which is not its default, and its verdicts, the lead pointing at it.
 */
const seed = ({ workspace }: TestTenant, slug: string, scored: boolean) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("qualification_test") },
    async (tx) => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      const personId = person.id;
      await createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } });
      if (!scored) return { personId, snapshotId: null, icpId: null };
      const icpId = newId("icp");
      await tx.icp.create({
        data: { id: icpId, workspaceId: workspace.id, name: AUDIENCE, isDefault: false },
      });
      const snapshotId = newId("ssn");
      const scores = {
        fitScore: 82,
        confidence: "high",
        tier: "hot",
        status: "qualified",
      } as const;
      await tx.scoreSnapshot.create({
        data: {
          ...scores,
          id: snapshotId,
          workspaceId: workspace.id,
          personId,
          icpId,
          icpVersion: 2,
          modelId: "fake-model",
          promptVersion: 1,
          scorerVersion: "fit-v1",
          disqualifiers: ["recruiter"],
          summary: SUMMARY,
          decisionRecordId: `dr_${snapshotId}`,
        },
      });
      const rows = VERDICTS.map((verdict) => ({ ...verdict, id: newId("cvd"), snapshotId }));
      await tx.criterionVerdict.createMany({
        data: rows.map((row) => ({ ...row, workspaceId: workspace.id })),
      });
      const { status, fitScore, confidence, tier } = scores;
      const decision = { status, fitScore, confidence, tier, snapshotId, icpId, icpVersion: 2 };
      await applyQualification({ personId, ...decision });
      return { personId, snapshotId, icpId };
    },
    { client: asRole("app") },
  );

const SIGNAL_AT = { strong: "2026-10-30T09:00:00.000Z", newer: "2026-11-01T09:00:00.000Z" };
/** The intent row of a scored lead, as the intent write leaves it, with a part of an older row. */
const writeIntentRow = ({ workspace, user }: TestTenant, personId: string) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("qualification_test") },
    (tx) =>
      tx.intentScore.create({
        data: {
          workspaceId: workspace.id,
          personId,
          intentScore: 41,
          priority: 70,
          tier: "warm",
          intentBreakdown: [
            {
              ...{ eventId: "evt_strong", kind: "competitor_engagement", role: "comment" },
              ...{ contribution: 5.2, at: SIGNAL_AT.strong, ownerUserId: user.id },
            },
            {
              ...{ eventId: "evt_newer", kind: "my_post_engagement", role: "reaction" },
              ...{ contribution: 3.4, at: SIGNAL_AT.newer, ownerUserId: null },
            },
            { eventId: "evt_older_row", kind: "topic_engagement", role: "author", contribution: 1 },
          ],
          whyNowEventId: "evt_strong",
          boostUntil: null,
          scorerVersion: "intent-v1",
          computedAt: new Date("2026-11-02T08:00:00.000Z"),
        },
      }),
    { client: asRole("app") },
  );

/** GET …/qualification/leads/{personId}/snapshot of the workspace, signed in as the user. */
async function snapshotOf(workspaceId: string, personId: string, userId: string) {
  const cookie = signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const path = `/v1/workspaces/${workspaceId}/qualification/leads/${personId}/snapshot`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET …/qualification/leads/{personId}/snapshot answers the lead's current snapshot, the audience it was judged against by name, its verdicts in the criteria's order, `intent` null without a row; 404 for a lead without one and for another workspace's person", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ours = await seed(a, "ines-scored", true);
  const pending = await seed(a, "ines-pending", false);
  const theirs = await seed(b, "ines-scored", true);
  const ws = a.workspace.id;

  const { status, body } = await snapshotOf(ws, ours.personId, a.user.id);
  assert.equal(status, 200);
  const { scoredAt, ...rest } = body;
  const byCriterion = (x: { criterion: string }, y: { criterion: string }) =>
    ORDER.indexOf(x.criterion) - ORDER.indexOf(y.criterion);
  assert.deepEqual(rest, {
    snapshotId: ours.snapshotId,
    personId: ours.personId,
    audience: { id: ours.icpId, name: AUDIENCE, isDefault: false },
    status: "qualified",
    fitScore: 82,
    confidence: "high",
    tier: "hot",
    icpVersion: 2,
    scorerVersion: "fit-v1",
    summary: SUMMARY,
    disqualifiers: ["recruiter"],
    // The model's verdicts count: no member set one (lead-verdict-edit).
    verdicts: [...VERDICTS]
      .sort(byCriterion)
      .map((verdict) => ({ ...verdict, modelVerdict: verdict.verdict, member: null })),
    intent: null,
  });
  assert.ok(Date.parse(String(scoredAt)) > 0);

  assert.deepEqual(await snapshotOf(ws, pending.personId, a.user.id), {
    status: 404,
    body: { code: "score_snapshot_not_found" },
  });
  assert.deepEqual(await snapshotOf(ws, theirs.personId, a.user.id), {
    status: 404,
    body: { code: "lead_not_found" },
  });
});

test("with the lead's intent row, the snapshot answers `intent`: its scores and the lead's tier, why now with its date, each signal newest first, an older row's undated part last, no source's creator; the snapshot's tier stays the fit's", async () => {
  const [a] = await createTwoWorkspaces();
  const ours = await seed(a, "ines-intent", true);
  await writeIntentRow(a, ours.personId);

  const { status, body } = await snapshotOf(a.workspace.id, ours.personId, a.user.id);
  assert.equal(status, 200);
  assert.equal(body.tier, "hot", "the fit's tier");
  assert.deepEqual(body.intent, {
    intentScore: 41,
    priority: 70,
    tier: "warm",
    whyNow: { kind: "competitor_engagement", role: "comment", at: SIGNAL_AT.strong },
    boostUntil: null,
    breakdown: [
      {
        ...{ eventId: "evt_newer", kind: "my_post_engagement", role: "reaction" },
        ...{ contribution: 3.4, at: SIGNAL_AT.newer },
      },
      {
        ...{ eventId: "evt_strong", kind: "competitor_engagement", role: "comment" },
        ...{ contribution: 5.2, at: SIGNAL_AT.strong },
      },
      {
        ...{ eventId: "evt_older_row", kind: "topic_engagement", role: "author" },
        ...{ contribution: 1, at: null },
      },
    ],
    scorerVersion: "intent-v1",
    computedAt: "2026-11-02T08:00:00.000Z",
  });
  assert.ok(!JSON.stringify(body).includes(a.user.id), "no source's creator");
});

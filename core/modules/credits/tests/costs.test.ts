// The cost counter (alpha-p10-010; README "The cost counter"), on rows the factories write in this
// file's schema of the worktree's database: a fixture week of ten assessments at 0.2 credits, one
// signal run of four credits and three drafts gives the week's sums by action and by vendor and the
// cost per 100 qualified leads, from usage committed in the week only; another organization's
// workspace has its own. A signal-sourced lead costs its assessment, its draft and its share of the
// run's reads; an imported one has no share; another workspace's person is lead_not_found. The week's
// and the share's arithmetic, pure.
import assert from "node:assert/strict";
import test from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId, platformIds, servicePrincipal } from "@whytide/platform";
import { createScoreSnapshot } from "@whytide/qualification/testing";
import { createSignalEvent, createSignalRun, createSignalSource } from "@whytide/signals/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { share, sum } from "../domain/costs/decimal.ts";
import { leadCost, readShare } from "../domain/costs/lead.ts";
import { recentWeeks, weekOf, weekRange } from "../domain/costs/week.ts";
import { weeklyCosts } from "../domain/costs/weekly.ts";
import { ids } from "../ids.ts";

withTestDb();
useTenancyClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
const principal = servicePrincipal("credits_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

const WEEK = "2026-W43";
const MONDAY = new Date("2026-10-19T00:00:00.000Z");
const NEXT_MONDAY = new Date("2026-10-26T00:00:00.000Z");
const WEDNESDAY = new Date("2026-10-21T10:00:00.000Z");

/** A usage row as reserve writes one, then settled. */
function usage(tenant: TestTenant, row: { action: string; credits: string; subjectRef: string }) {
  return (status: "committed" | "reserved" | "released", createdAt = WEDNESDAY) =>
    asRole("app").creditUsage.create({
      data: {
        ...row,
        id: newId(ids.credit_usage),
        organizationId: tenant.workspace.organizationId,
        workspaceId: tenant.workspace.id,
        quantity: 1,
        status,
        idempotencyKey: newId(ids.credit_usage),
        leaseExpiresAt: new Date(createdAt.getTime() + 15 * 60_000),
        createdAt,
      },
    });
}

/** A cost event as callAgent records one. */
function call(tenant: TestTenant, row: { feature: string; vendor: string; unitCost: string }) {
  return (subjectRef: string, createdAt = WEDNESDAY) =>
    asRole("app").costEvent.create({
      data: {
        ...row,
        id: newId(platformIds.cost_event),
        workspaceId: tenant.workspace.id,
        units: { input_tokens: 1000 },
        priceListVersion: "test",
        subjectRef,
        createdAt,
      },
    });
}

/** A person with a lead, signal-sourced or imported, by contacts' commands. */
const leadOf = (tenant: TestTenant, slug: string, source: "signal" | "imported") =>
  inRun(tenant.workspace.id, async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, title: "Head of Data" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    await createLeadForPerson({ personId: person.id, source: { kind: source, ref: "src_test" } });
    return person.id;
  });

/**
 * The fixture week in A: ten assessments, the first two of leads (a signal's, an import's), one at
 * the week's first instant; a run of four credits that staged 80 candidates, one the signal lead's;
 * three drafts; four leads qualified. Around it, rows the week does not count.
 */
async function fixtureWeek(a: TestTenant) {
  const signalLead = await leadOf(a, "signal-lead", "signal");
  const importedLead = await leadOf(a, "imported-lead", "imported");
  const persons = [signalLead, importedLead, ...Array.from({ length: 8 }, (_, n) => `per_${n}`)];
  const workspaceId = a.workspace.id;
  const assessment = (subjectRef: string) =>
    usage(a, { action: "qualification.assessment", credits: "0.2", subjectRef });
  const assessed = call(a, { feature: "qualification", vendor: "anthropic", unitCost: "0.0021" });
  const drafted = call(a, { feature: "messaging", vendor: "example-llm", unitCost: "0.008" });
  for (const [n, personId] of persons.entries()) {
    await assessment(personId)("committed", n === 0 ? MONDAY : WEDNESDAY);
    await assessed(personId);
  }
  for (const personId of persons.slice(0, 3)) await drafted(personId);
  const { id: sourceId } = await createSignalSource({ workspaceId, label: "Launch post" });
  const counts = { pages: 4, read: 95, staged: 80, created: 1 };
  const run = await createSignalRun({ workspaceId, sourceId, status: "done", counts });
  await createSignalEvent({ workspaceId, personId: signalLead, sourceId, runId: run.id });
  await usage(a, { action: "signals.engager_read", credits: "4", subjectRef: run.id })("committed");
  for (const personId of persons.slice(0, 4)) {
    await createScoreSnapshot({ workspaceId, personId, status: "qualified", createdAt: WEDNESDAY });
  }
  // Not this week's: reserved or released, before or after it, a re-score's copy, not qualified.
  const outside = assessment("per_outside");
  await outside("reserved");
  await outside("released");
  await outside("committed", NEXT_MONDAY);
  await outside("committed", new Date(MONDAY.getTime() - 1));
  await assessed("per_outside", NEXT_MONDAY);
  const copy = { status: "qualified", createdAt: WEDNESDAY, criteriaHash: "a".repeat(64) } as const;
  await createScoreSnapshot({ workspaceId, personId: persons[4] ?? "", ...copy });
  await createScoreSnapshot({ workspaceId, personId: persons[5] ?? "", status: "not_qualified" });
  return { signalLead, importedLead };
}

test("weeklyCosts: ten assessments at 0.2, a run of 4 credits and three drafts; sums by action and vendor, per 100 qualified; another organization's workspace its own", async () => {
  const [a, b] = await createTwoWorkspaces();
  await fixtureWeek(a);
  await usage(b, { action: "test.read", credits: "1", subjectRef: "lead_b" })("committed");
  await call(b, { feature: "onboarding", vendor: "example-pages", unitCost: "0.004" })("cmp_b");

  const ofA = await inRun(a.workspace.id, () =>
    weeklyCosts({ workspaceId: a.workspace.id, week: WEEK }),
  );
  assert.deepEqual(ofA, {
    week: WEEK,
    start: MONDAY,
    end: NEXT_MONDAY,
    credits: "6",
    money: "0.045",
    qualified: 4,
    byAction: [
      { action: "qualification.assessment", credits: "2" },
      { action: "signals.engager_read", credits: "4" },
    ],
    byVendor: [
      { vendor: "anthropic", money: "0.021" },
      { vendor: "example-llm", money: "0.024" },
    ],
    costPer100Qualified: { credits: "150", money: "1.125" },
  });
  const ofB = await inRun(b.workspace.id, () =>
    weeklyCosts({ workspaceId: b.workspace.id, week: WEEK }),
  );
  assert.deepEqual(
    [ofB.credits, ofB.money, ofB.qualified, ofB.byAction, ofB.byVendor, ofB.costPer100Qualified],
    [
      "1",
      "0.004",
      0,
      [{ action: "test.read", credits: "1" }],
      [{ vendor: "example-pages", money: "0.004" }],
      null,
    ],
  );
  const mismatch = { code: "tenant_mismatch" };
  await assert.rejects(
    inRun(a.workspace.id, () => weeklyCosts({ workspaceId: b.workspace.id, week: WEEK })),
    mismatch,
  );
  const invalid = { code: "credits_input_invalid", details: { fields: ["week"] } };
  await assert.rejects(
    inRun(a.workspace.id, () => weeklyCosts({ workspaceId: a.workspace.id, week: "2025-W53" })),
    invalid,
  );
});

test("leadCost: a signal-sourced lead is its assessment, its draft and the run's credits ÷ its candidates; an imported lead has no read share; another workspace's person is lead_not_found", async () => {
  const [a, b] = await createTwoWorkspaces();
  const { signalLead, importedLead } = await fixtureWeek(a);
  const assessment = { feature: "qualification", credits: "0.2", money: "0.0021" };
  const draft = { feature: "messaging", credits: "0", money: "0.008" };
  const reads = { feature: "signals", credits: "0.05", money: "0" };
  assert.deepEqual(await inRun(a.workspace.id, () => leadCost(signalLead)), {
    personId: signalLead,
    credits: "0.25",
    money: "0.0101",
    byFeature: [draft, assessment, reads],
  });
  assert.deepEqual(await inRun(a.workspace.id, () => leadCost(importedLead)), {
    personId: importedLead,
    credits: "0.2",
    money: "0.0101",
    byFeature: [draft, assessment],
  });
  const notFound = { code: "lead_not_found" };
  await assert.rejects(
    inRun(b.workspace.id, () => leadCost(signalLead)),
    notFound,
  );
  await assert.rejects(
    inRun(a.workspace.id, () => leadCost("per_none")),
    notFound,
  );
});

test("the week: ISO, in UTC, from Monday 00:00 to the next Monday excluded; a week the year lacks is null", () => {
  const w43 = { week: WEEK, start: MONDAY, end: NEXT_MONDAY };
  assert.deepEqual(weekOf(WEDNESDAY), w43);
  assert.deepEqual(weekOf(MONDAY), w43);
  assert.deepEqual(weekOf(new Date(NEXT_MONDAY.getTime() - 1)), w43);
  assert.equal(weekOf(NEXT_MONDAY).week, "2026-W44");
  // 2026 begins on a Thursday: its week 1 starts on 2025-12-29, and it has a week 53.
  assert.deepEqual(weekOf(new Date("2026-01-01T12:00:00.000Z")), {
    week: "2026-W01",
    start: new Date("2025-12-29T00:00:00.000Z"),
    end: new Date("2026-01-05T00:00:00.000Z"),
  });
  assert.equal(weekOf(new Date("2027-01-01T00:00:00.000Z")).week, "2026-W53");
  assert.deepEqual(weekRange(WEEK), w43);
  assert.equal(weekRange("2026-W53")?.start.toISOString(), "2026-12-28T00:00:00.000Z");
  for (const week of ["2025-W53", "2026-W00", "2026-W54", "2026-43", "W43"]) {
    assert.equal(weekRange(week), null, week);
  }
  assert.deepEqual(
    recentWeeks(WEDNESDAY, 3).map(({ week }) => week),
    ["2026-W43", "2026-W42", "2026-W41"],
  );
});

test("the amounts: exact sums of decimal strings, and a share cut at the 30th decimal", () => {
  assert.equal(sum(Array.from({ length: 10 }, () => "0.2")), "2");
  assert.equal(sum([]), "0");
  assert.equal(share("0.045", 100, 4), "1.125");
  const run = (runId: string, candidates: number, personCandidates: number) => ({
    runId,
    candidates,
    personCandidates,
  });
  const credits = new Map([
    ["run_a", "4"],
    ["run_b", "1"],
  ]);
  assert.equal(readShare([run("run_a", 120, 1)], credits), `0.0${"3".repeat(29)}`);
  assert.equal(readShare([run("run_a", 80, 2), run("run_b", 10, 1)], credits), "0.2");
  assert.equal(readShare([run("run_gone", 10, 1)], credits), "0");
});

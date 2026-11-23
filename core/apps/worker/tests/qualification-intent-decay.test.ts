// qualification's nightly decay (gamma-p5-060; core/modules/qualification/README.md "Intent and
// priority"), on the slice's Temporal and a schema of its database: qualification loaded from its
// build by the worker's own loader, its activities through the host's wrapper, a fake signal reader
// put in place through the build's testing/, the time passed in (no test reads the clock). A lead
// decided at T0 with a competitor's post commented that day: the tick starts each workspace's decay
// with its time; the first night lowers the intent and keeps the boost, the third ends it, Hot to
// Warm, with no status change and no event; a workspace whose start fails leaves the others started
// and fails the tick with its code; the schedule, daily at 02:30 UTC. Contacts, icp, tenancy and
// qualification come from their builds, the files the loader's modules import. The replay of the
// recorded histories is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { TenantClient } from "@whytide/db";
import type { WorkflowStart } from "@whytide/platform";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { upsertSchedules } = await import("../src/schedules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { ids, scoreSnapshot } = await import(built("qualification/dist/index.js"));
const { useQualificationClient, useSignalReader } = await import(
  built("qualification/dist/testing/index.js")
);
const { useTenancyClient } = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = () => asRole("app");
useHashSalt("test-salt-".repeat(4));
useQualificationClient(app());
useTenancyClient(app());
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const qualification = moduleLoaders.filter(({ name }) => name === "qualification");
const loaded = await loadModules(qualification);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app(), log })];
  }),
);
/** The code of the activity failure that failed a workflow. */
const codeOf = (error: unknown) =>
  (error as { cause?: { cause?: { type?: string } } }).cause?.cause?.type;

const principal = platform.servicePrincipal("test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app() });
const T0 = new Date("2026-11-02T10:00:00.000Z");
const NIGHT_1 = "2026-11-03T02:30:00.000Z";
const NIGHT_3 = "2026-11-05T02:30:00.000Z";
const VERDICTS = [
  ["title_function", "met", "Head of Revenue Operations"],
  ["seniority", "met", "Head of Revenue Operations"],
  ["company_size", "met", "51-200"],
  ["industry", "met", "Software"],
  ["location", "met", "Germany (DE)"],
  ["must_haves", "unknown", ""],
] as const;
/** Per person, the reader's items: a competitor's post commented on at T0. */
const signals = new Map<string, Date>();
const reader = {
  intentInputs: async ({ personIds }: { personIds: readonly string[] }) =>
    personIds.flatMap((personId) => {
      const at = signals.get(personId);
      if (at === undefined) return [];
      const event = { personId, eventId: `evt_${personId}`, sourceId: "src_1", count: 1 };
      const rated = { relevance: 1, intentClass: "other", ownerUserId: null };
      return [
        { ...event, ...rated, kind: "competitor_engagement", role: "comment", occurredAt: at },
      ];
    }),
  excerpts: async () => [],
};

/** A workspace of its own organization; its id starts with `prefix`, which orders the tick's list. */
async function workspaceOf(prefix = "wsp") {
  const organizationId = `org_${randomUUID()}`;
  const workspaceId = `${prefix}_${randomUUID()}`;
  await app().organization.create({
    data: { id: organizationId, name: "Org", slug: organizationId },
  });
  const workspace = { id: workspaceId, organizationId, name: "Workspace", slug: "workspace" };
  await app().workspace.create({ data: workspace });
  return workspaceId;
}

/** A lead whose assessment, its six verdicts stored, is scored at T0 with its signal of T0. */
async function decidedLead(workspaceId: string) {
  return inRun(workspaceId, async (tx) => {
    const profile = { linkedinUrl: "https://linkedin.com/in/noor-decay", firstName: "Noor" };
    const imported = { source: "import", provider: "csv" };
    const { person } = await contacts.upsertPersonFromSource({ ...imported, profile });
    const personId = person.id as string;
    await contacts.createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } });
    const snapshotId = platform.newId(ids.score_snapshot);
    const model = { modelId: "fake-model", promptVersion: 1, summary: "", disqualifiers: [] };
    await tx.scoreSnapshot.create({
      data: {
        id: snapshotId,
        workspaceId,
        personId,
        icpVersion: 1,
        ...model,
        decisionRecordId: `dr_${snapshotId}`,
      },
    });
    await tx.criterionVerdict.createMany({
      data: VERDICTS.map(([criterion, verdict, evidence]) => ({
        ...{ id: platform.newId(ids.criterion_verdict), workspaceId, snapshotId },
        ...{ criterion, verdict, evidence },
      })),
    });
    signals.set(personId, T0);
    await scoreSnapshot(snapshotId, T0);
    return personId;
  });
}
const stateOf = async (workspaceId: string, personId: string) => {
  const where = { workspaceId, personId };
  const lead = await app().lead.findFirstOrThrow({ where });
  const row = await app().intentScore.findFirstOrThrow({ where });
  const { intentScore: intent, priority, tier, boostUntil, computedAt } = row;
  return {
    status: lead.qualificationStatus,
    leadTier: lead.tier,
    intent,
    priority,
    tier,
    boostUntil,
    computedAt,
  };
};

test("each night's decay lowers the intent as the days pass and ends the boost after 48 hours, Hot to Warm, with no status change and no event; the tick starts every workspace's with its time", async () => {
  const restore = useSignalReader(reader);
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  try {
    const workspaceId = await workspaceOf();
    const personId = await decidedLead(workspaceId);
    const decided = await stateOf(workspaceId, personId);
    const boost = new Date("2026-11-04T10:00:00.000Z");
    assert.deepEqual(decided, {
      ...{ status: "qualified", leadTier: "hot", intent: 53, priority: 82, tier: "hot" },
      ...{ boostUntil: boost, computedAt: T0 },
    });

    /** The tick at `at`, then the decay it started, run as started. */
    const night = async (at: string) => {
      starts.length = 0;
      const tick = await runWorkflow("qualification_intent_decay_tick", { at }, { activities });
      assert.deepEqual(tick, { workspaces: 1, started: 1 });
      assert.deepEqual(starts, [
        {
          workflow: "qualification_intent_decay",
          input: { workspaceId, at },
          workflowId: `qualification.intent_decay:${workspaceId}:current`,
          oneAtATime: true,
        },
      ]);
      const [start] = starts;
      return runWorkflow(start?.workflow ?? "", start?.input, { activities });
    };
    assert.deepEqual(await night(NIGHT_1), { updated: 1 });
    assert.deepEqual(await stateOf(workspaceId, personId), {
      ...{ status: "qualified", leadTier: "hot", intent: 52, priority: 82, tier: "hot" },
      ...{ boostUntil: boost, computedAt: new Date(NIGHT_1) },
    });
    assert.deepEqual(await night(NIGHT_3), { updated: 1 });
    assert.deepEqual(await stateOf(workspaceId, personId), {
      ...{ status: "qualified", leadTier: "warm", intent: 48, priority: 70, tier: "warm" },
      ...{ boostUntil: null, computedAt: new Date(NIGHT_3) },
    });
    const lead = await app().lead.findFirstOrThrow({ where: { workspaceId, personId } });
    const why = lead.why as { key: string; params: Record<string, unknown> }[];
    assert.deepEqual(why[1], {
      key: "qualification.why.why_now",
      params: { kind: "competitor_engagement", role: "comment", days: 2 },
    });
    const name = "qualification.lead_qualified";
    assert.equal(await app().outboxEntry.count({ where: { eventName: name } }), 0);

    // The same night again finds nothing left to recompute.
    assert.deepEqual(await night(NIGHT_3), { updated: 0 });
  } finally {
    unbind();
    restore();
  }
});

test("the tick: a workspace whose start fails leaves the others started and fails the tick with its code", async () => {
  // The broken workspace comes first in the tick's list.
  const broken = await workspaceOf("wsp_a");
  const fine = await workspaceOf("wsp_b");
  const starts: WorkflowStart[] = [];
  const unbind = platform.bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      if (request.input.workspaceId !== broken) return { started: true };
      throw new platform.AppError(platform.workflowErrors.workflows_not_bound);
    },
  });
  try {
    const tick = runWorkflow("qualification_intent_decay_tick", { at: NIGHT_1 }, { activities });
    await assert.rejects(tick, (error) => codeOf(error) === "workflows_not_bound");
  } finally {
    unbind();
  }
  // Each of the activity's three attempts goes on to the fine workspace after the broken one.
  const tried = starts.map(({ input }) => input.workspaceId);
  assert.deepEqual(tried, [broken, fine, broken, fine, broken, fine]);
});

test("the decay's schedule: qualification.intent_decay, daily at 02:30 UTC; two upserts leave one", async () => {
  const schedules = loaded.schedules.filter(({ id }) => id === "qualification.intent_decay");
  assert.equal(schedules.length, 1);
  const handle = env.client.schedule.getHandle("qualification.intent_decay");
  await handle.delete().catch(() => undefined);
  const options = { taskQueue: env.taskQueue, paused: true };
  try {
    await upsertSchedules(env.client, schedules, options);
    const created = await handle.describe();
    await upsertSchedules(env.client, schedules, options);
    const described = await handle.describe();
    assert.deepEqual(described.info.createdAt, created.info.createdAt);
    assert.equal(described.action.workflowType, "qualification_intent_decay_tick");
    const [daily] = described.spec.calendars ?? [];
    const at = (range = [{ start: -1 }]) => range.map(({ start }) => start);
    assert.deepEqual(
      [at(daily?.hour), at(daily?.minute), described.spec.timezone],
      [[2], [30], "UTC"],
    );
  } finally {
    await handle.delete().catch(() => undefined);
  }
});

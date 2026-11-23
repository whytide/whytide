// Pausing (gamma-p3-060; README.md "Pausing"), on the worktree's database in this file's schema,
// each call in a tenant run as `app`, the module's clock on a Tuesday morning: an enrollment's and
// a campaign's transitions and their refusals; a campaign's resume taking a waiting step's lead's
// lock, then its enrollment's, before it clears the step's code (gamma-p3-061); the database's
// refusals (a pause's columns exactly while paused, one live enrollment a person, active or
// paused); the resume at the queue run's start (campaigns_due_steps) for a time passed only; what a
// pause keeps (the acceptance and the first message's due time) and what it passes over (the
// withdrawal); and a campaign made without steps on the warm signal. The routes are the api's
// (core/apps/api/tests/campaigns-pause.test.ts).
import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { lockLeadStatus } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import type { Prisma, TenantClient } from "@whytide/db";
import { asRole, sqlstate, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { recordAcceptance } from "../domain/acceptance.ts";
import { createCampaign, seedCampaign } from "../domain/campaigns/commands.ts";
import { FALLBACK_CONDITION, FALLBACK_DELAY } from "../domain/campaigns/constants.ts";
import { versionSteps } from "../domain/campaigns/reads.ts";
import { pauseCampaign, resumeCampaign } from "../domain/pause/campaign.ts";
import { pauseEnrollment, resumeEnrollment } from "../domain/pause/enrollment.ts";
import { dueStepIds } from "../domain/queue/due.ts";
import { lockEnrollment } from "../domain/steps/skip.ts";
import { openWithdrawals } from "../domain/withdraw/open.ts";
import { ids } from "../ids.ts";
import { useClock } from "../testing/index.ts";
import { activities } from "../workflows/index.ts";
import { fixture } from "./fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const AT = new Date("2026-11-03T10:00:00Z");
useClock(() => AT);
const WORKSPACE = "wsp_campaigns_pause";
const { app, run, owned, account, enrolledLead } = fixture(WORKSPACE);
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const CHECK = "23514";
/** How often, and how many times, a test looks whether a run waits on a lock. */
const LOCK_POLL_MS = 25;
const LOCK_POLLS = 120;

/** The table whose row lock the backend `pid` waits on now, from its query; null while none. */
async function waitingOn(pid: number): Promise<string | null> {
  const [row] = await app().$queryRaw<{ query: string }[]>`
    SELECT query FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock'`;
  return row ? (/FROM (\w+)/.exec(row.query)?.[1] ?? row.query) : null;
}

/** Whether another transaction may lock the row now: free, or locked by a run that holds it. */
const rowLock = async (rows: Promise<unknown[]>) => ((await rows).length > 0 ? "free" : "locked");

/**
 * `fn` in a run of its own while another run holds the row that `hold` locks: the table `fn`'s run
 * waits on, with what `seen` reads meanwhile, before the holder lets go; null when it went on
 * without waiting. Then both runs end, `fn`'s committed.
 */
async function blockedBy<T>(
  hold: (tx: TenantClient) => Promise<unknown>,
  fn: () => Promise<unknown>,
  seen: () => Promise<T>,
): Promise<{ waitedOn: string | null; seen: T }> {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = () => {};
  const holding = new Promise<void>((resolve) => {
    held = resolve;
  });
  const holder = run(async (tx) => {
    await hold(tx);
    held();
    await released;
  });
  await holding;
  let pid: number | undefined;
  let ended = false;
  const ran = run(async (tx) => {
    const [backend] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    pid = backend?.pid;
    return fn();
  });
  const settled = ran.then(
    () => {
      ended = true;
    },
    () => {
      ended = true;
    },
  );
  try {
    for (let polls = 0; polls < LOCK_POLLS && !ended; polls++) {
      const table = pid === undefined ? null : await waitingOn(pid);
      if (table !== null) return { waitedOn: table, seen: await seen() };
      await sleep(LOCK_POLL_MS);
    }
    return { waitedOn: null, seen: await seen() };
  } finally {
    release();
    await holder;
    await settled;
    await ran;
  }
}

/**
 * The workspace's Owner, the approver, whom the seeded campaign and a new one are owned by: a
 * campaign sends from its owner's account (gamma-p6-040).
 */
const ownedWorkspace = (): Promise<string> => owned();

const pauseOf = async (id: string) => {
  const { status, pausedReason, pausedUntil } = await app().enrollment.findUniqueOrThrow({
    where: { id },
  });
  return { status, pausedReason, pausedUntil };
};

test("an enrollment pauses, until a time or not, and resumes; the wrong state or an unknown id is refused", async () => {
  await account();
  const { enrollmentId } = await enrolledLead("pause-enrollment");
  const until = new Date(AT.getTime() + 2 * DAY_MS);
  const paused = { id: enrollmentId, status: "paused", pausedReason: "user", pausedUntil: until };
  assert.deepEqual(
    await run(() => pauseEnrollment(enrollmentId, { reason: "user", until })),
    paused,
  );
  const { id: _, ...row } = paused;
  assert.deepEqual(await pauseOf(enrollmentId), row);
  const refused = (code: string, status: number) => ({ code, status });
  await assert.rejects(
    run(() => pauseEnrollment(enrollmentId, { reason: "out_of_office" })),
    refused("enrollment_not_active", 409),
  );
  const active = { id: enrollmentId, status: "active", pausedReason: null, pausedUntil: null };
  assert.deepEqual(await run(() => resumeEnrollment(enrollmentId)), active);
  await assert.rejects(
    run(() => resumeEnrollment(enrollmentId)),
    refused("enrollment_not_paused", 409),
  );
  const byHand = await run(() => pauseEnrollment(enrollmentId, { reason: "out_of_office" }));
  assert.deepEqual([byHand.pausedReason, byHand.pausedUntil], ["out_of_office", null]);
  for (const id of ["enl_unknown", ""]) {
    await assert.rejects(
      run(() => pauseEnrollment(id, { reason: "user" })),
      refused("enrollment_not_found", 404),
    );
    await assert.rejects(
      run(() => resumeEnrollment(id)),
      refused("enrollment_not_found", 404),
    );
  }
  // An enrollment that ended is not paused, nor resumed.
  const ended = { status: "completed", endedAt: AT, pausedReason: null } as const;
  await app().enrollment.update({ where: { id: enrollmentId }, data: ended });
  await assert.rejects(
    run(() => pauseEnrollment(enrollmentId, { reason: "user" })),
    refused("enrollment_not_active", 409),
  );
  await assert.rejects(
    run(() => resumeEnrollment(enrollmentId)),
    refused("enrollment_not_paused", 409),
  );
});

test("a campaign pauses and resumes; a draft is not paused, and the wrong state or an unknown id is refused", async () => {
  const owner = await ownedWorkspace();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const paused = { id: seeded.id, status: "paused", pausedReason: "user", pausedAt: AT };
  assert.deepEqual(await run(() => pauseCampaign(seeded.id, { reason: "user" })), paused);
  const refused = (code: string, status: number) => ({ code, status });
  await assert.rejects(
    run(() => pauseCampaign(seeded.id, { reason: "bounce_rate" })),
    refused("campaign_not_active", 409),
  );
  const active = { id: seeded.id, status: "active", pausedReason: null, pausedAt: null };
  assert.deepEqual(await run(() => resumeCampaign(seeded.id)), active);
  await assert.rejects(
    run(() => resumeCampaign(seeded.id)),
    refused("campaign_not_paused", 409),
  );
  const bounced = await run(() => pauseCampaign(seeded.id, { reason: "bounce_rate" }));
  assert.equal(bounced.pausedReason, "bounce_rate");
  const draft = await run(() =>
    createCampaign({ name: "Not launched", ownerUserId: owner, createdBy: owner }),
  );
  await assert.rejects(
    run(() => pauseCampaign(draft.campaignId, { reason: "user" })),
    refused("campaign_not_active", 409),
  );
  await assert.rejects(
    run(() => resumeCampaign(draft.campaignId)),
    refused("campaign_not_paused", 409),
  );
  await assert.rejects(
    run(() => pauseCampaign("cmp_unknown", { reason: "user" })),
    refused("campaign_not_found", 404),
  );
});

test("a campaign's resume takes a waiting step's lead's lock, then its enrollment's, before it clears the step's code", async () => {
  await ownedWorkspace();
  await account();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const { personId, enrollmentId, steps } = await enrolledLead("pause-resume-locks");
  const step = steps.connect;
  /** The campaign paused, its connection request waiting on it as the claim's gate leaves it. */
  const waiting = async () => {
    await run(() => pauseCampaign(seeded.id, { reason: "user" }));
    const data = { status: "scheduled", errorCode: "campaign_not_active" } as const;
    await app().stepExecution.update({ where: { id: step }, data });
  };
  const codeOf = async () =>
    (await app().stepExecution.findUniqueOrThrow({ where: { id: step } })).errorCode;
  const lead = () =>
    rowLock(app().$queryRaw<unknown[]>`
      SELECT 1 FROM leads WHERE workspace_id = ${WORKSPACE} AND person_id = ${personId}
      FOR UPDATE SKIP LOCKED`);
  const enrollment = () =>
    rowLock(app().$queryRaw<unknown[]>`
      SELECT 1 FROM enrollments WHERE workspace_id = ${WORKSPACE} AND id = ${enrollmentId}
      FOR UPDATE SKIP LOCKED`);
  const stepRow = () =>
    rowLock(app().$queryRaw<unknown[]>`
      SELECT 1 FROM step_executions WHERE workspace_id = ${WORKSPACE} AND id = ${step}
      FOR UPDATE SKIP LOCKED`);

  // The lead held by another run: the resume waits on it, the enrollment and the step not locked yet.
  await waiting();
  const onLead = await blockedBy(
    () => lockLeadStatus(personId),
    () => resumeCampaign(seeded.id),
    async () => ({ enrollment: await enrollment(), step: await stepRow() }),
  );
  assert.deepEqual(onLead, { waitedOn: "leads", seen: { enrollment: "free", step: "free" } });
  assert.equal(await codeOf(), null, "cleared once it held the lead");

  // The enrollment held: the resume holds the lead and waits on it, the step not locked yet.
  await waiting();
  const onEnrollment = await blockedBy(
    (tx) => lockEnrollment(tx, enrollmentId),
    () => resumeCampaign(seeded.id),
    async () => ({ lead: await lead(), step: await stepRow() }),
  );
  assert.deepEqual(onEnrollment, {
    waitedOn: "enrollments",
    seen: { lead: "locked", step: "free" },
  });
  assert.equal(await codeOf(), null, "cleared once it held the enrollment");
});

test("the database refuses a pause's columns off the status, and a second live enrollment of one person", async () => {
  await ownedWorkspace();
  await account();
  const { personId, enrollmentId } = await enrolledLead("pause-tables");
  const enrollment = (data: Prisma.EnrollmentUpdateInput) =>
    app().enrollment.update({ where: { id: enrollmentId }, data });
  assert.equal(await sqlstate(enrollment({ status: "paused" })), CHECK, "paused with no reason");
  assert.equal(await sqlstate(enrollment({ pausedReason: "user" })), CHECK, "a reason, active");
  assert.equal(await sqlstate(enrollment({ pausedUntil: AT })), CHECK, "a time, active");
  const paused = { status: "paused", pausedReason: "user" } as const;
  assert.equal(await sqlstate(enrollment({ ...paused, endedAt: AT })), CHECK, "an end, paused");
  assert.equal(await sqlstate(enrollment({ ...paused, pausedUntil: AT })), undefined);
  // The person's live enrollment is paused: a second one, active or paused, is refused.
  for (const status of ["active", "paused"] as const) {
    const second = app().enrollment.create({
      data: {
        ...{ id: newId(ids.enrollment), workspaceId: WORKSPACE, personId, status },
        ...{ templateId: "linkedin_default", templateVersion: 1, sourceEventId: newId("obx") },
        ...(status === "paused" && { pausedReason: "user" as const }),
      },
    });
    await assert.rejects(second, { code: "P2002", message: /`enrollments_active_person`/ }, status);
  }
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const campaign = (data: Prisma.CampaignUpdateInput) =>
    app().campaign.update({ where: { id: seeded.id }, data });
  assert.equal(await sqlstate(campaign({ status: "paused", pausedReason: "user" })), CHECK);
  assert.equal(await sqlstate(campaign({ status: "paused", pausedAt: AT })), CHECK);
  assert.equal(await sqlstate(campaign({ pausedReason: "user", pausedAt: AT })), CHECK);
  const pausedCampaign = { status: "paused", pausedReason: "user", pausedAt: AT } as const;
  assert.equal(await sqlstate(campaign(pausedCampaign)), undefined);
});

test("the queue run's start resumes an enrollment whose time has passed, before it lists due steps; one paused by hand or until later stays paused", async () => {
  await account();
  const [due, byHand, later] = [
    await enrolledLead("pause-due"),
    await enrolledLead("pause-by-hand"),
    await enrolledLead("pause-later"),
  ];
  const pauses = [
    [due, { reason: "out_of_office", until: new Date(AT.getTime() - 60_000) }],
    [byHand, { reason: "user" }],
    [later, { reason: "user", until: new Date(AT.getTime() + HOUR_MS) }],
  ] as const;
  for (const [{ enrollmentId, steps }, pause] of pauses) {
    await run(() => pauseEnrollment(enrollmentId, pause));
    // The connection request waits on the pause, as the gate leaves it; message_1 is due.
    const waiting = { status: "scheduled", errorCode: "enrollment_paused" } as const;
    await app().stepExecution.update({ where: { id: steps.connect }, data: waiting });
    await app().stepExecution.update({ where: { id: steps.message_1 }, data: { dueAt: AT } });
  }
  const tenant = <T>(fn: (tx: unknown) => Promise<T>) => run(fn);
  const context = { workspaceId: WORKSPACE, workflowId: "wf_queue", attempt: 1, tenant };
  const listed = await activities.campaigns_due_steps.run({ workspaceId: WORKSPACE }, context);
  // A tick's first page, and its last (gamma-p0-085).
  assert.deepEqual(listed, { stepIds: [due.steps.message_1], next: null });
  const resumed = { status: "active", pausedReason: null, pausedUntil: null };
  assert.deepEqual(await pauseOf(due.enrollmentId), resumed);
  for (const { enrollmentId } of [byHand, later]) {
    assert.equal((await pauseOf(enrollmentId)).status, "paused");
  }
  const codes = await app().stepExecution.findMany({
    where: { stepKey: "connect" },
    select: { enrollmentId: true, errorCode: true },
  });
  const codeOf = (id: string) => codes.find(({ enrollmentId }) => enrollmentId === id)?.errorCode;
  assert.deepEqual(
    [codeOf(due.enrollmentId), codeOf(byHand.enrollmentId), codeOf(later.enrollmentId)],
    [null, "enrollment_paused", "enrollment_paused"],
  );
});

test("a paused enrollment keeps its acceptance and its first message's due time, opened after the resume; the withdrawal passes it over until then", async () => {
  const { id: accountId } = await account();
  const accepted = await enrolledLead("pause-accepted");
  const sentAt = new Date(AT.getTime() - 22 * DAY_MS);
  const sent = { status: "succeeded", executedAt: sentAt } as const;
  await app().stepExecution.update({ where: { id: accepted.steps.connect }, data: sent });
  await run(() => pauseEnrollment(accepted.enrollmentId, { reason: "user" }));
  assert.deepEqual(await run(() => openWithdrawals(AT)), { opened: 0 }, "passed over");

  const input = { senderAccountId: accountId, personId: accepted.personId, detectedAt: AT };
  assert.equal(await run((tx) => recordAcceptance(tx, input)), "due");
  const { dueAt } = await app().stepExecution.findUniqueOrThrow({
    where: { id: accepted.steps.message_1 },
  });
  assert.ok(dueAt !== null);
  assert.deepEqual(await run(() => dueStepIds(dueAt)), [], "not opened while paused");
  await run(() => resumeEnrollment(accepted.enrollmentId));
  assert.deepEqual(await run(() => dueStepIds(dueAt)), [accepted.steps.message_1]);

  // Another person's request, not accepted after 21 days: withdrawn once the enrollment resumes.
  const waiting = await enrolledLead("pause-withdraw");
  await app().stepExecution.update({ where: { id: waiting.steps.connect }, data: sent });
  await run(() => pauseEnrollment(waiting.enrollmentId, { reason: "user" }));
  assert.deepEqual(await run(() => openWithdrawals(AT)), { opened: 0 });
  await run(() => resumeEnrollment(waiting.enrollmentId));
  assert.deepEqual(await run(() => openWithdrawals(AT)), { opened: 1 });
});

test("a campaign made without steps gets the warm signal's seven, the fallback's emails marked", async () => {
  const owner = await ownedWorkspace();
  const made = await run(() =>
    createCampaign({ name: "Warm", ownerUserId: owner, createdBy: owner }),
  );
  const steps = await run(() => versionSteps(made.campaignId, made.versionNo));
  assert.deepEqual(
    steps?.map(({ stepKey, condition }) => [stepKey, condition ?? null]),
    [
      ["connect", null],
      ["message_1", null],
      ["follow_up_1", null],
      ["follow_up_2", null],
      ["email_1", FALLBACK_CONDITION],
      ["email_2", FALLBACK_CONDITION],
      ["email_3", FALLBACK_CONDITION],
    ],
  );
  assert.deepEqual(steps?.[4]?.delay, FALLBACK_DELAY);
  const stored = await app().step.findMany({ orderBy: { position: "asc" } });
  assert.deepEqual(
    stored.map(({ condition }) => condition),
    [null, null, null, null, FALLBACK_CONDITION, FALLBACK_CONDITION, FALLBACK_CONDITION],
  );
});

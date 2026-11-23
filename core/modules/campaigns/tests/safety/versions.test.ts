// The safety cases of campaign versions (gamma-p3-030; README.md "Campaigns and versions"), run by
// `pnpm -F campaigns test:safety`, on the worktree's database in this file's schema, each call in a
// tenant run as `app`, the lead enrolled by the subscriber's body: an edit never changes an
// enrollment in flight, whose rows, keys and due times stay its version's; the seeded campaign's
// keys are beta's; the same content twice for one person in one campaign is refused at the claim;
// and an email step, due, is picked by no queue run, no plan and no LinkedIn sender.
import assert from "node:assert/strict";
import test from "node:test";
import { recordLeadStatus } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { newId } from "@whytide/platform";
import { saveVersion, seedCampaign } from "../../domain/campaigns/commands.ts";
import { FIRST_MESSAGE_DELAY } from "../../domain/campaigns/constants.ts";
import { versionSteps } from "../../domain/campaigns/reads.ts";
import { enrollApproved } from "../../domain/enroll/enroll.ts";
import { planAccount, scheduledAccounts } from "../../domain/plan/account.ts";
import { dueStepIds } from "../../domain/queue/due.ts";
import { claimStep } from "../../domain/send/claim.ts";
import { nextStep } from "../../domain/send/next.ts";
import { TEMPLATE_ID, TEMPLATE_STEPS } from "../../domain/template/constants.ts";
import { idempotencyKey, stepTemplateHash } from "../../domain/template/keys.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_versions";
const f = fixture(WORKSPACE);
const { app, run, account, moveStep, dueAt, queue, skipItem, decide } = f;
const CONNECT = { action: "invite", delay: { anchor: "enrollment" } } as const;
const FIRST_MESSAGE = { action: "message", delay: FIRST_MESSAGE_DELAY } as const;
const after = (value: number) => ({ anchor: "prev_step", unit: "business_days", value }) as const;
const message = (days: number) => ({ action: "message", delay: after(days) }) as const;
const email = (days: number) => ({ action: "email", delay: after(days) }) as const;

/**
 * The workspace's rows in tenancy and its Owner, the approver: the user the seeded campaign is owned
 * by, whose account it sends from.
 */
const ownedWorkspace = (): Promise<string> => f.owned();

/** A person enrolled by the subscriber's body; its step ids by key, whatever the version's keys. */
async function enrolled(slug: string) {
  const { personId, enrollmentId, steps } = await f.enrolledLead(slug);
  return { personId, enrollmentId, steps: steps as Record<string, string> };
}

/** The person's step rows as an edit could change them, by position. */
const rowsOf = async (personId: string) =>
  (await app().stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })).map(
    ({ stepKey, position, actionType, stepTemplateHash, idempotencyKey, templateVersion }) => ({
      ...{ stepKey, position, actionType, stepTemplateHash, idempotencyKey, templateVersion },
    }),
  );

/** The message_1 skipped by its owner at `at`, as "Up next" leaves it: what follows is made due. */
async function skipFirstMessage(steps: Record<string, string>, at: Date): Promise<void> {
  await moveStep(steps.connect ?? "", "succeeded");
  await dueAt(steps.message_1 ?? "", at);
  assert.equal(await queue(steps.message_1 ?? ""), "opened");
  await skipItem(steps.message_1 ?? "", at);
  assert.equal(await decide(steps.message_1 ?? ""), "skipped");
}

const dueOf = async (id: string | undefined) =>
  (await app().stepExecution.findUniqueOrThrow({ where: { id: id ?? "" } })).dueAt?.toISOString();

test("an edit never changes an enrollment in flight: its rows, keys and due times stay its version's, and only the next enrollment joins the new version", async () => {
  const owner = await ownedWorkspace();
  await account("Asia/Kolkata");
  const before = await enrolled("versions-before");
  const rows = await rowsOf(before.personId);
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const edited = [CONNECT, FIRST_MESSAGE, message(6), message(5)];
  const saved = await run(() => saveVersion(seeded.id, edited, { createdBy: owner }));
  assert.deepEqual([saved.versionNo, saved.written], [2, true]);
  assert.deepEqual(await rowsOf(before.personId), rows, "the edit wrote nothing on the enrollment");
  const later = await enrolled("versions-after");
  const versions = await app().enrollment.findMany({ orderBy: { createdAt: "asc" } });
  assert.deepEqual(
    versions.map(({ templateId, templateVersion }) => [templateId, templateVersion]),
    [
      [TEMPLATE_ID, 1],
      [TEMPLATE_ID, 2],
    ],
  );
  // Both message_1 skipped on a Friday, 17:30 in Kolkata (12:00 UTC): the follow-up of version 1
  // falls three business days later, Wednesday; version 2's six, the Monday after.
  const friday = new Date("2026-10-30T12:00:00Z");
  await skipFirstMessage(before.steps, friday);
  await skipFirstMessage(later.steps, friday);
  assert.equal(await dueOf(before.steps.follow_up_1), "2026-11-04T12:00:00.000Z");
  assert.equal(await dueOf(later.steps.follow_up_1), "2026-11-09T12:00:00.000Z");
  assert.deepEqual(
    (await rowsOf(before.personId)).map(({ idempotencyKey }) => idempotencyKey),
    rows.map(({ idempotencyKey }) => idempotencyKey),
  );
});

test("the seeded campaign's version 1 is beta's template, with beta's keys for the same person", async () => {
  await ownedWorkspace();
  await account();
  const { personId } = await enrolled("versions-seeded");
  const steps = await run(() => versionSteps(TEMPLATE_ID, 1));
  const stored = await app().step.findMany({ orderBy: { position: "asc" } });
  const template = TEMPLATE_STEPS.map((step) => ({
    ...{ stepKey: step.stepKey, position: step.position, action: step.action },
    ...{ channel: step.channel, delay: step.delay, stepTemplateHash: stepTemplateHash(step) },
  }));
  assert.deepEqual(steps, template);
  assert.equal(stored.length, TEMPLATE_STEPS.length, "the seeded version's own rows");
  const beta = TEMPLATE_STEPS.map((step) =>
    idempotencyKey({
      workspaceId: WORKSPACE,
      personId,
      templateId: TEMPLATE_ID,
      stepTemplateHash: stepTemplateHash(step),
    }),
  );
  assert.deepEqual(
    (await rowsOf(personId)).map(({ idempotencyKey }) => idempotencyKey),
    beta,
  );
});

test("the same content twice for one person in one campaign is refused at the claim, across versions", async () => {
  const owner = await ownedWorkspace();
  await account();
  const first = await enrolled("versions-twice");
  await moveStep(first.steps.connect ?? "", "succeeded");
  // The person's enrollment ends, a version 2 changes a follow-up only, and the person is approved
  // and enrolled again: the connection request is the same content, with the same key.
  const ended = { status: "completed", endedAt: new Date() } as const;
  await app().enrollment.update({ where: { id: first.enrollmentId }, data: ended });
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const edited = [CONNECT, FIRST_MESSAGE, message(4), message(5)];
  await run(() => saveVersion(seeded.id, edited, { createdBy: owner }));
  await run(() =>
    recordLeadStatus(first.personId, "approved", { actor: { type: "user", id: APPROVER } }),
  );
  const again = { sourceEventId: newId("obx"), personId: first.personId, approvedBy: APPROVER };
  const outcome = await run((tx) => enrollApproved(tx, again));
  assert.equal(outcome, "enrolled");
  const rows = await app().stepExecution.findMany({
    where: { personId: first.personId },
    orderBy: [{ templateVersion: "asc" }, { position: "asc" }],
  });
  const of = (version: number, key: string) =>
    rows.find((row) => row.templateVersion === version && row.stepKey === key);
  const [a, b] = [of(1, "connect"), of(2, "connect")];
  assert.ok(a && b);
  assert.equal(a.idempotencyKey, b.idempotencyKey, "an unchanged step keeps its hash and key");
  assert.notEqual(of(1, "follow_up_1")?.idempotencyKey, of(2, "follow_up_1")?.idempotencyKey);
  await assert.rejects(
    app().stepExecution.update({ where: { id: b.id }, data: { status: "executing" } }),
    { code: "P2002", message: /`step_executions_key_claimed`/ },
  );
});

test("an email step, due, is picked by no queue run, no plan and no LinkedIn sender", async () => {
  const owner = await ownedWorkspace();
  const { id: accountId } = await account();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  const sequence = [CONNECT, FIRST_MESSAGE, email(2), email(2)];
  await run(() => saveVersion(seeded.id, sequence, { createdBy: owner }));
  const { personId, steps } = await enrolled("versions-email");
  const emails = await app().stepExecution.findMany({
    where: { personId, actionType: "email" },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    emails.map(({ stepKey, senderAccountId, mailboxId }) => [stepKey, senderAccountId, mailboxId]),
    [
      ["email_1", null, null],
      ["email_2", null, null],
    ],
  );
  // A Tuesday, 10:00 UTC, in the account's window. email_1 due and planned; email_2 even placed for
  // now, as nothing writes it, so that every filter shows.
  const at = new Date("2026-11-03T10:00:00Z");
  await moveStep(steps.connect ?? "", "succeeded");
  await dueAt(steps.email_1 ?? "", new Date(at.getTime() - 60_000));
  await app().stepExecution.update({
    where: { id: steps.email_2 ?? "" },
    data: { status: "scheduled", dueAt: at, scheduledFor: at, quotaDay: "2026-11-03" },
  });
  assert.deepEqual(await run(() => dueStepIds(at)), [], "no queue run");
  assert.equal(await queue(steps.email_1 ?? ""), "passed_over");
  assert.deepEqual(await run(() => scheduledAccounts()), [], "no plan lists it");
  // Sending stays closed in the tests, so the plan stops at the account's window; what it would read
  // is the account's own scheduled LinkedIn steps, which an email step, with no account, is not.
  const { kept, released, placed: planned } = await run(() => planAccount(accountId, at));
  assert.deepEqual({ kept, released, planned }, { kept: 0, released: 0, planned: 0 }, "no plan");
  assert.equal((await run(() => nextStep(accountId, at))).step, null, "no next step");
  const placed = { stepExecutionId: steps.email_2 ?? "", scheduledFor: at };
  assert.deepEqual(await run(() => claimStep(placed, at)), { blocked: "step_not_ready" });
  const left = await app().stepExecution.findMany({
    where: { personId, actionType: "email" },
    orderBy: { position: "asc" },
  });
  assert.deepEqual(
    left.map(({ status, attempt, scheduledFor }) => [status, attempt, scheduledFor?.toISOString()]),
    [
      ["planned", 0, undefined],
      ["scheduled", 0, at.toISOString()],
    ],
  );
});

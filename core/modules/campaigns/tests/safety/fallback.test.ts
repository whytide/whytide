// The safety cases of the email fallback (gamma-p3-060; README.md "The fallback"), run by `pnpm -F
// campaigns test:safety`, on the worktree's database in this file's schema, each call in a tenant
// run as `app`, the lead enrolled by the subscriber's body on the seeded campaign's warm-signal
// version: the first fallback email falls due 7 days after the connection request went out, from a
// fixed instant; an acceptance before the fallback, between the queue and the claim, or after
// email_1 went out leaves no pending fallback step, each skipped with invite_accepted, its item
// blocked, and none is claimed; a skipped fallback email leaves every LinkedIn step as it was.
// Nothing sends an email before gamma-p4-010: an item written here stands in for the one its queue
// will open, and an email step's status is moved as its sender will move it.
import assert from "node:assert/strict";
import test from "node:test";
import { createApprovalItem } from "@whytide/approvals/testing";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { recordAcceptance } from "../../domain/acceptance.ts";
import { saveVersion, seedCampaign } from "../../domain/campaigns/commands.ts";
import { checkGate } from "../../domain/gate/gate.ts";
import { claimStep } from "../../domain/send/claim.ts";
import { settleSend } from "../../domain/send/settle.ts";
import { SKIPPED_STEP_FIELDS, skipStep } from "../../domain/steps/skip.ts";
import { WARM_SIGNAL_STEPS } from "../../domain/template/warm-signal.ts";
import { APPROVER, fixture } from "../fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
const WORKSPACE = "wsp_campaigns_fallback_safety";
const f = fixture(WORKSPACE);
const { app, run, account, moveStep, stepsOf, enrollmentOf, itemOf } = f;
const DAY_MS = 86_400_000;
/** The connection request went out on a Monday, 10:00 UTC; the acceptance came two days later. */
const SENT_AT = new Date("2026-11-02T10:00:00Z");
const ACCEPTED_AT = new Date(SENT_AT.getTime() + 2 * DAY_MS);
const EMAILS = ["email_1", "email_2", "email_3"] as const;
const LINKEDIN = ["connect", "message_1", "follow_up_1", "follow_up_2"] as const;
const SKIPPED = ["skipped", "invite_accepted"];

/** The approver the workspace's Owner, with its account; the seeded campaign on the warm signal. */
async function warmWorkspace(): Promise<string> {
  const owner = await f.owned();
  const { id: accountId } = await account();
  const seeded = await run(() => seedCampaign());
  assert.ok(seeded);
  await run(() => saveVersion(seeded.id, WARM_SIGNAL_STEPS, { createdBy: owner }));
  return accountId;
}

/** A person enrolled on the warm-signal version, its connection request sent at SENT_AT. */
async function invited(slug: string) {
  const { personId, enrollmentId, steps } = await f.enrolledLead(slug);
  const ids = steps as Record<string, string>;
  const id = (key: string): string => ids[key] ?? assert.fail(`no step ${key}`);
  // Claimed as the sender leaves it, then settled as sent.
  await moveStep(id("connect"), "executing");
  const holds = { usageId: null, reservationId: null };
  const answer = { sent: true, stepExecutionId: id("connect") } as const;
  await run(() => settleSend({ stepExecutionId: id("connect"), holds, answer }, SENT_AT));
  return { personId, enrollmentId, id };
}

const accept = (senderAccountId: string, personId: string) =>
  run((tx) => recordAcceptance(tx, { senderAccountId, personId, detectedAt: ACCEPTED_AT }));
/** The person's steps as [key, status, skip_reason] by position. */
const statuses = async (personId: string) =>
  (await stepsOf(personId)).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]);
/** The fallback's steps as [status, skip_reason]. */
const fallbackOf = async (personId: string) =>
  (await statuses(personId)).slice(LINKEDIN.length).map(([, status, reason]) => [status, reason]);
/** The person's LinkedIn rows, every column, so that a write of any kind shows. */
const linkedinRows = (personId: string) =>
  app().stepExecution.findMany({
    where: { personId, stepKey: { in: [...LINKEDIN] } },
    orderBy: { position: "asc" },
  });

/**
 * No fallback email passes the gate or is claimed after the acceptance, whatever its status: the
 * sender of gamma-p4-010 runs the same gate before its claim.
 */
async function noneClaimed(id: (key: string) => string): Promise<void> {
  for (const key of EMAILS) {
    const gate = await run(() => checkGate(id(key), { at: ACCEPTED_AT }));
    assert.deepEqual([gate.pass, !gate.pass && gate.reason], [false, "step_not_ready"], key);
    const placed = { stepExecutionId: id(key), scheduledFor: ACCEPTED_AT };
    const claim = await run(() => claimStep(placed, ACCEPTED_AT));
    assert.deepEqual(claim, { blocked: "step_not_ready" }, key);
  }
  const executing = { actionType: "email", status: "executing" } as const;
  assert.equal(await app().stepExecution.count({ where: executing }), 0);
}

test("the first fallback email falls due 7 calendar days after the connection request went out, the others after it", async () => {
  await warmWorkspace();
  const { personId, id } = await invited("fallback-due");
  const connect = await app().stepExecution.findUniqueOrThrow({ where: { id: id("connect") } });
  assert.equal(connect.executedAt?.toISOString(), SENT_AT.toISOString());
  const emails = await app().stepExecution.findMany({
    where: { personId, stepKey: { in: [...EMAILS] } },
    orderBy: { position: "asc" },
  });
  // Seven days of 24 hours from the instant it went out, a weekend among them: Monday to Monday.
  assert.deepEqual(
    emails.map(({ stepKey, status, dueAt }) => [stepKey, status, dueAt?.toISOString() ?? null]),
    [
      ["email_1", "planned", new Date(SENT_AT.getTime() + 7 * DAY_MS).toISOString()],
      ["email_2", "planned", null],
      ["email_3", "planned", null],
    ],
  );
  assert.deepEqual(
    (await linkedinRows(personId)).map(({ status, dueAt }) => [status, dueAt]),
    [
      ["succeeded", connect.dueAt],
      ["planned", null],
      ["planned", null],
      ["planned", null],
    ],
    "the LinkedIn messages wait for the acceptance",
  );
});

test("an acceptance before the fallback skips its three emails with invite_accepted, and the LinkedIn steps go on", async () => {
  const accountId = await warmWorkspace();
  const { personId, enrollmentId, id } = await invited("fallback-before");
  assert.equal(await accept(accountId, personId), "due");
  assert.deepEqual(await fallbackOf(personId), [SKIPPED, SKIPPED, SKIPPED]);
  const [, message] = await linkedinRows(personId);
  assert.ok(message?.status === "planned" && message.dueAt !== null, "message_1 due");
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  await noneClaimed(id);
});

test("an acceptance between the queue and the claim skips the opened email, its item blocked, and the gate skips one claimed meanwhile", async () => {
  const accountId = await warmWorkspace();
  // email_1 opened in "Up next" when the acceptance lands.
  const opened = await invited("fallback-opened");
  const itemId = await createApprovalItem({
    ...{ workspaceId: WORKSPACE, personId: opened.personId, senderAccountId: accountId },
    ...{ stepExecutionId: opened.id("email_1"), stepKey: "email_1", actionType: "message" },
  });
  await app().stepExecution.update({
    where: { id: opened.id("email_1") },
    data: { status: "awaiting_approval", approvalItemId: itemId },
  });
  assert.equal(await accept(accountId, opened.personId), "due");
  assert.deepEqual(await fallbackOf(opened.personId), [SKIPPED, SKIPPED, SKIPPED]);
  assert.equal((await itemOf(opened.id("email_1")))?.status, "blocked");
  await noneClaimed(opened.id);

  // email_1 claimed when the acceptance lands: the acceptance skips the two others; the gate right
  // before the call, as the sender of gamma-p4-010 will run it, skips email_1.
  const claimed = await invited("fallback-claimed");
  await moveStep(claimed.id("email_1"), "executing");
  assert.equal(await accept(accountId, claimed.personId), "due");
  assert.deepEqual(await fallbackOf(claimed.personId), [["executing", null], SKIPPED, SKIPPED]);
  const before = await linkedinRows(claimed.personId);
  const gate = await run(() => checkGate(claimed.id("email_1"), { at: ACCEPTED_AT }));
  assert.deepEqual([gate.pass, !gate.pass && gate.reason], [false, "invite_accepted"]);
  assert.deepEqual(await fallbackOf(claimed.personId), [SKIPPED, SKIPPED, SKIPPED]);
  assert.deepEqual(await linkedinRows(claimed.personId), before, "the LinkedIn steps as they were");
  assert.equal((await enrollmentOf(claimed.enrollmentId)).status, "active");
  await noneClaimed(claimed.id);
});

test("an acceptance after email_1 went out skips the two emails left", async () => {
  const accountId = await warmWorkspace();
  const { personId, enrollmentId, id } = await invited("fallback-after");
  // email_1 sent as gamma-p4-010's settle will leave it, email_2 due three business days later.
  const sentAt = new Date(SENT_AT.getTime() + 7 * DAY_MS);
  await app().stepExecution.update({
    where: { id: id("email_1") },
    data: { status: "succeeded", executedAt: sentAt },
  });
  await f.dueAt(id("email_2"), new Date(sentAt.getTime() + 3 * DAY_MS));
  assert.equal(await accept(accountId, personId), "due");
  assert.deepEqual(await fallbackOf(personId), [["succeeded", null], SKIPPED, SKIPPED]);
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  await noneClaimed(id);
});

test("a skipped fallback email leaves every LinkedIn step of the enrollment as it was, and the enrollment goes on", async () => {
  await warmWorkspace();
  const { personId, enrollmentId, id } = await invited("fallback-skipped");
  const before = await linkedinRows(personId);
  /** The email skipped by its owner at `at`, as "Up next" leaves it (../../domain/decisions.ts). */
  async function ownerSkips(key: string, at: Date): Promise<void> {
    await moveStep(id(key), "scheduled");
    const step = await app().stepExecution.findUniqueOrThrow({
      where: { id: id(key) },
      select: SKIPPED_STEP_FIELDS,
    });
    const skip = { reason: "skipped_by_owner", at, actor: { type: "user", id: APPROVER } } as const;
    assert.equal(await run((tx) => skipStep(tx, { ...step, status: "scheduled" }, skip)), true);
    assert.deepEqual(await linkedinRows(personId), before, `after ${key}`);
  }
  const dueOf = async (key: string) =>
    (await app().stepExecution.findUniqueOrThrow({ where: { id: id(key) } })).dueAt?.toISOString();

  // Monday the 9th, 12:00 UTC (the account's zone): email_2 three business days on, Thursday;
  // email_3 five after that, the next Thursday.
  await ownerSkips("email_1", new Date("2026-11-09T12:00:00Z"));
  assert.equal(await dueOf("email_2"), "2026-11-12T12:00:00.000Z");
  await ownerSkips("email_2", new Date("2026-11-12T12:00:00Z"));
  assert.equal(await dueOf("email_3"), "2026-11-19T12:00:00.000Z");
  // The fallback's last step skipped: the LinkedIn steps are still open, so the enrollment goes on.
  await ownerSkips("email_3", new Date("2026-11-19T12:00:00Z"));
  const skippedByOwner = ["skipped", "skipped_by_owner"];
  assert.deepEqual(await fallbackOf(personId), [skippedByOwner, skippedByOwner, skippedByOwner]);
  assert.equal((await enrollmentOf(enrollmentId)).status, "active");
  assert.equal((await f.leadOf(personId)).status, "in_campaign");
});

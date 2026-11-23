// Hot leads first (gamma-p5-070; README.md "Worker", docs/flows.md "The daily plan"), on the
// worktree's database in this file's schema, through planAccount in a tenant run as `app`, the
// leads' priorities written by qualification's setLeadPriority, sending open, the clocks on a
// Tuesday morning inside the account's hours: with room for one connection request, the Hot
// lead's, due later, is placed and the Warm lead's waits, and with no priorities the earlier due;
// messages to leads of priority 90, 60 and none take the earliest times in that order, all before a
// Hot lead's connection request, and withdrawals keep their due order; a step placed earlier today
// keeps its time and its room when a Hot lead's falls due; a Hot lead with two due steps gets one,
// and none on a day touched; a Hot lead erased after the read gets no step, the Warm one the room;
// and the priorities of more persons than one read takes are read in pages. The mailbox's plan's
// cases come with gamma-p4-010 (the email phase).
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { erasePerson, recordTouch, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { remainingToday } from "@whytide/linkedin";
import {
  createConnectedAccount,
  openSending,
  useLinkedinClient,
  useClock as useLinkedinClock,
  useRandom as useLinkedinRandom,
} from "@whytide/linkedin/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { setLeadPriority } from "@whytide/qualification/testing";
import { duePriorities, planAccount } from "../domain/plan/account.ts";
import { PRIORITY_READ_MAX } from "../domain/plan/constants.ts";
import type { PlanStep } from "../domain/plan/place.ts";
import { ids } from "../ids.ts";
import { useClock, useRandom } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
// A Tuesday, 10:00 UTC, inside the account's hours (09:00 to 18:00 UTC): the plan's clock and
// linkedin's.
const AT = new Date("2026-11-03T10:00:00Z");
useClock(() => AT);
useLinkedinClock(() => AT);
useRandom(() => 0.5);
useLinkedinRandom(() => 0.999);
// Sending open, as the operator opens it (beta-p1-040): a fresh database has it closed.
beforeEach(() => openSending());
const WORKSPACE = "wsp_campaigns_plan_priority";
const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 };
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** Hot and Warm, as gamma-p5-060's tiers start at 75 and 55. */
const HOT = 90;
const WARM = 60;

const app = () => asRole("app");
const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId: WORKSPACE, principal: servicePrincipal("plan_priority") }, fn, {
    client: app(),
  });
const ago = (ms: number) => new Date(AT.getTime() - ms);
const plan = (accountId: string) => run(() => planAccount(accountId, AT));
const timeOf = async (id: string) =>
  (await app().stepExecution.findUniqueOrThrow({ where: { id } })).scheduledFor;

type Lead = { readonly personId: string; readonly enrollmentId: string };
type Action = "invite" | "message" | "withdraw";
/** Each action's step key, as the template names its first step of the action. */
const KEY_OF = { invite: "connect", message: "message_1", withdraw: "withdraw" } as const;

/** A person of the workspace through contacts' command, its priority unless null, enrolled. */
async function leadOf(accountId: string, slug: string, priority: number | null): Promise<Lead> {
  const personId = await run(async () => {
    const profile = {
      linkedinUrl: `https://linkedin.com/in/plan-priority-${slug}`,
      firstName: "Noor",
    };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    if (priority !== null) await setLeadPriority(person.id, priority);
    return person.id;
  });
  const enrollmentId = newId(ids.enrollment);
  await app().enrollment.create({
    data: {
      ...{ id: enrollmentId, workspaceId: WORKSPACE, personId, senderAccountId: accountId },
      ...{ ...TEMPLATE, status: "active", sourceEventId: newId("obx"), startedAt: ago(DAY_MS) },
    },
  });
  return { personId, enrollmentId };
}

/** The lead's step `scheduled`, as its approval leaves it, due `dueAt` and unplaced: its id. */
async function scheduledStep(lead: Lead, key: string, actionType: Action, dueAt: Date) {
  const id = newId(ids.step_execution);
  const account = await app().enrollment.findUniqueOrThrow({ where: { id: lead.enrollmentId } });
  await app().stepExecution.create({
    data: {
      ...{ id, workspaceId: WORKSPACE, personId: lead.personId, enrollmentId: lead.enrollmentId },
      ...{ ...TEMPLATE, senderAccountId: account.senderAccountId, stepKey: key, position: 1 },
      ...{ actionType, stepTemplateHash: key, idempotencyKey: `${lead.personId}:${key}` },
      ...{ status: "scheduled", dueAt },
    },
  });
  return id;
}

/** A lead of `priority` (null: none) with one step of the action, due `agoMs` ago: its id. */
async function dueStep(
  accountId: string,
  slug: string,
  priority: number | null,
  action: Action,
  agoMs: number,
): Promise<string> {
  return scheduledStep(await leadOf(accountId, slug, priority), KEY_OF[action], action, ago(agoMs));
}

/** linkedin's day row made, then so used that `invites` connection requests are left today. */
async function inviteRoom(accountId: string, invites: number): Promise<void> {
  const left = (await run(() => remainingToday(accountId))).invites;
  await app().senderQuotaUsage.updateMany({
    where: { senderAccountId: accountId },
    data: { invitesCommitted: { increment: left - invites } },
  });
  assert.equal((await run(() => remainingToday(accountId))).invites, invites);
}

/** The steps' times, in the order given; each placed. */
async function timesOf(stepIds: readonly string[]): Promise<number[]> {
  const times = await Promise.all(stepIds.map(timeOf));
  return times.map((time, index) => {
    assert.ok(time !== null, `${stepIds[index]} has no time`);
    return time.getTime();
  });
}
const ascending = (times: readonly number[]) =>
  times.every((t, i) => i === 0 || t > (times[i - 1] ?? t));

test("room for one connection request: the Hot lead's, due later, is placed and the Warm lead's waits", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  await inviteRoom(accountId, 1);
  const warm = await dueStep(accountId, "warm", WARM, "invite", 3 * HOUR_MS);
  const hot = await dueStep(accountId, "hot", HOT, "invite", HOUR_MS);
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 0, released: 0, placed: 1 });
  assert.notEqual(await timeOf(hot), null, "the Hot lead's is placed");
  assert.equal(await timeOf(warm), null, "the Warm lead's waits");
});

test("with no priorities, the plan places what it placed before: the connection request due first, and messages by due time", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  await inviteRoom(accountId, 1);
  const early = await dueStep(accountId, "early", null, "invite", 3 * HOUR_MS);
  const late = await dueStep(accountId, "late", null, "invite", HOUR_MS);
  const messages = [
    await dueStep(accountId, "m-first", null, "message", 3 * HOUR_MS),
    await dueStep(accountId, "m-second", null, "message", 2 * HOUR_MS),
    await dueStep(accountId, "m-third", null, "message", HOUR_MS),
  ];
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 0, released: 0, placed: 4 });
  assert.equal(await timeOf(late), null, "the later connection request waits");
  const times = await timesOf([...messages, early]);
  assert.ok(ascending(times), "the messages by due time, then the connection request");
});

test("messages to leads of priority 90, 60 and none take the earliest times in that order, before withdrawals by their due time, whatever their leads' priorities, and then a Hot lead's connection request", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  // The due times run against the priorities: the lowest is due first.
  const invite = await dueStep(accountId, "invite-hot", HOT, "invite", HOUR_MS);
  const withdrawHot = await dueStep(accountId, "withdraw-hot", HOT, "withdraw", HOUR_MS);
  const withdrawNone = await dueStep(accountId, "withdraw-none", null, "withdraw", 2 * HOUR_MS);
  const message90 = await dueStep(accountId, "message-90", 90, "message", HOUR_MS);
  const message60 = await dueStep(accountId, "message-60", 60, "message", 2 * HOUR_MS);
  const messageNone = await dueStep(accountId, "message-none", null, "message", 3 * HOUR_MS);
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 0, released: 0, placed: 6 });
  const order = [message90, message60, messageNone, withdrawNone, withdrawHot, invite];
  assert.ok(ascending(await timesOf(order)), "placed in that order");
});

test("a step placed earlier today keeps its time and its room when a Hot lead's falls due: the Hot lead's connection request waits", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  await inviteRoom(accountId, 1);
  const warm = await dueStep(accountId, "warm", WARM, "invite", HOUR_MS);
  const hotLead = await leadOf(accountId, "hot", HOT);
  assert.equal((await plan(accountId)).placed, 1);
  const placed = await timeOf(warm);
  assert.ok(placed !== null && placed > AT);
  // The Hot lead's falls due after the run that placed the Warm lead's.
  const hot = await scheduledStep(hotLead, "connect", "invite", ago(MINUTE_MS));
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 1, released: 0, placed: 0 });
  assert.equal((await timeOf(warm))?.getTime(), placed.getTime(), "the kept time stands");
  assert.equal(await timeOf(hot), null, "the Hot lead's waits for the next room");
});

test("a Hot lead with two due steps gets one a day, and a Hot lead touched today none; the room goes to the Warm lead", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  const hot = await leadOf(accountId, "hot", HOT);
  const first = await scheduledStep(hot, "message_1", "message", ago(2 * HOUR_MS));
  const second = await scheduledStep(hot, "follow_up_1", "message", ago(HOUR_MS));
  const touchedLead = await leadOf(accountId, "touched", HOT);
  await run(() => recordTouch(touchedLead.personId, ago(MINUTE_MS)));
  const touched = await scheduledStep(touchedLead, "message_1", "message", ago(3 * HOUR_MS));
  const warm = await dueStep(accountId, "warm", WARM, "message", HOUR_MS);
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 0, released: 0, placed: 2 });
  assert.ok(ascending(await timesOf([first, warm])), "the Hot lead's first, then the Warm lead's");
  assert.equal(await timeOf(second), null, "one step a day");
  assert.equal(await timeOf(touched), null, "none on a day touched");
});

test("a Hot lead erased after the read gets no step, as before: its intent row and steps still there, contacts no longer holds it, and the Warm lead takes the one room", async () => {
  const { id: accountId } = await createConnectedAccount(WORKSPACE);
  await inviteRoom(accountId, 1);
  const hotLead = await leadOf(accountId, "hot", HOT);
  const hot = await scheduledStep(hotLead, "connect", "invite", ago(HOUR_MS));
  const warm = await dueStep(accountId, "warm", WARM, "invite", 2 * HOUR_MS);
  // contacts' eraser alone, as privacy's runs one module at a time: qualification's row and the
  // step stay, so the read still finds the lead Hot.
  await run(() => erasePerson(hotLead.personId));
  const read = await run(() => duePriorities([stepOf(hotLead.personId)], AT));
  assert.equal(read.get(hotLead.personId), HOT);
  assert.deepEqual(await plan(accountId), { skipped: null, kept: 0, released: 0, placed: 1 });
  assert.equal(await timeOf(hot), null, "the erased lead's waits");
  assert.notEqual(await timeOf(warm), null, "the Warm lead's is placed");
});

test("the priorities of more due persons than one read takes are read in pages, the last page's too; a person whose steps are not due yet is not read", async () => {
  const last = `per_page_${PRIORITY_READ_MAX + 1}`;
  const steps = Array.from({ length: PRIORITY_READ_MAX + 2 }, (_, index) =>
    stepOf(`per_page_${index}`),
  );
  await run(async () => {
    await setLeadPriority("per_page_0", WARM);
    await setLeadPriority(last, HOT);
    await setLeadPriority("per_later", HOT);
  });
  const later = { ...stepOf("per_later"), dueAt: new Date(AT.getTime() + MINUTE_MS) };
  const priorities = await run(() => duePriorities([...steps, later], AT));
  assert.deepEqual(
    new Map(priorities),
    new Map([
      ["per_page_0", WARM],
      [last, HOT],
    ]),
  );
});

/** A due, unplaced connection request of the person, as the plan reads one. */
function stepOf(personId: string): PlanStep {
  const step = { id: `sx_${personId}`, personId, actionType: "invite", position: 1 } as const;
  return { ...step, dueAt: ago(HOUR_MS), scheduledFor: null, quotaDay: null };
}

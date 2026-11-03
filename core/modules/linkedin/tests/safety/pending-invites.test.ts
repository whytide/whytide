// The safety cases of the pending invitations (beta-p4-070; RB-11.2.5, no new invitation while more
// than 400 are pending; docs/concepts.md "Pending invitations"), run by `pnpm -F @whytide/linkedin
// test:safety`. Failing closed: 401 pending, a count never checked and one checked more than 48 hours
// ago refuse an invite, logged, by the reservation and by the send activity's gate, while messages
// and withdrawals reserve; an invite refused before the day's check retries after it; each committed
// invite adds one to the count until the next check, so the day's invites are never forgotten, and
// one committed while the check runs is added to the count it writes; the invites in flight count
// with the pending ones; and campaigns' plan is told no invite is left meanwhile. A failed check
// writes no count, and a warning it meets pauses the account as a read's does. A person gone at the
// vendor closes its invite and the check goes on; an invite sent before the account's latest pairing
// is never asked about; a pairing during the check writes no count (beta-p6-020).
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { AppError } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { findAccount } from "../../domain/accounts.ts";
import { type Called, type CheckCalls, checkInvites } from "../../domain/invites/check.ts";
import type { Relation } from "../../domain/invites/pending.ts";
import { remainingToday } from "../../domain/quota/reservations.ts";
import { sendStateRefusal } from "../../domain/send/state.ts";
import type { SendActionType } from "../../schemas/quota.ts";
import { createInvites, useClock, useLinkedinClient, useRandom } from "../../testing/index.ts";
import { ALWAYS, granted, sender, THURSDAY } from "../fixtures/send.ts";

withTestDb();
const app = asRole("app");
useLinkedinClient(app);
let today = THURSDAY;
useClock(() => today);
useRandom(() => 0.5);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** The next quota day's start after THURSDAY, in UTC. */
const FRIDAY = new Date("2026-10-23T00:00:00Z");

type Sender = Awaited<ReturnType<typeof sender>>;
type Answer = { reservationId: string } | { refused: string; retryAt: Date | null };

const shown = (answer: Answer) =>
  "refused" in answer ? [answer.refused, answer.retryAt] : ["granted", null];
/** An invite's, a message's and a withdrawal's answers, `[code, retryAt]` or `["granted", null]`. */
async function answers(account: Sender, key: string) {
  const types: SendActionType[] = ["invite", "message", "withdraw"];
  const all: Answer[] = [];
  for (const type of types) all.push(await account.send(`${key}-${type}`, type));
  return all.map(shown);
}
/** The send activity's re-read just before the port call (domain/send/gate.ts), for its `own` slot. */
const gate = (account: Sender, type: SendActionType = "invite", own?: string) =>
  account.run(async () => sendStateRefusal(await findAccount(account.id), type, today, own));
const pending = async (id: string) =>
  (await app.senderAccount.findUniqueOrThrow({ where: { id } })).pendingInvites;
const logged = (id: string, outcome: string) =>
  app.senderActionLog.count({ where: { senderAccountId: id, kind: "invite", outcome } });

test.afterEach(() => {
  today = THURSDAY;
});

/** Today's row made, at `day`, and the clock moved a minute past its check_after: the check due. */
async function checkDue(account: Sender, day = THURSDAY): Promise<void> {
  today = day;
  await account.run(() => remainingToday(account.id));
  const checkAfter = (await account.days()).at(-1)?.checkAfter ?? null;
  assert.ok(checkAfter !== null);
  today = new Date(checkAfter.getTime() + 60_000);
}

/**
 * The check's calls: the vendor's list empty, after `listed` ran; each relation by its member's
 * `relations` entry, connected when it has none. The calls made, as `method` or `getRelation:member`.
 */
function callsOf(
  account: Sender,
  relations: Readonly<Record<string, Called<Relation>>> = {},
  listed: () => Promise<unknown> = async () => undefined,
) {
  const called: string[] = [];
  const calls: CheckCalls = {
    tenant: (fn) => account.run(fn),
    listPendingInvites: async () => {
      called.push("listPendingInvites");
      await listed();
      return { ok: { invites: [], nextCursor: null } };
    },
    getRelation: async (memberRef) => {
      called.push(`getRelation:${memberRef}`);
      return relations[memberRef] ?? { ok: { connected: true, invitationPending: false } };
    },
  };
  return { calls, called };
}

test("401 pending refuses an invite pending_invites_over_limit until the next quota day, logged, by the reservation and by the gate, while a message and a withdrawal reserve; 400 pending lets it through", async () => {
  const over = await sender("UTC", ALWAYS, {
    pendingInvites: 401,
    pendingInvitesCheckedAt: THURSDAY,
  });
  const refused = ["pending_invites_over_limit", FRIDAY];
  assert.deepEqual(await answers(over, "over"), [refused, ["granted", null], ["granted", null]]);
  assert.deepEqual(await gate(over), { refused: "pending_invites_over_limit", retryAt: FRIDAY });
  assert.equal(await gate(over, "message"), null);
  assert.equal(await logged(over.id, "pending_invites_over_limit"), 1);

  const at = await sender("UTC", ALWAYS, {
    pendingInvites: 400,
    pendingInvitesCheckedAt: THURSDAY,
  });
  granted(await at.send("at-the-limit"));
});

test("a count never checked refuses an invite pending_invites_unknown until the hourly run after today's check: an hour after check_after while it lies ahead, an hour after now once it is due, the next quota day once the day's check is made; messages and withdrawals reserve", async () => {
  const unknown = await sender("UTC", ALWAYS, {
    pendingInvites: null,
    pendingInvitesCheckedAt: null,
  });
  const before = await answers(unknown, "before");
  const [day] = await unknown.days();
  const checkAfter = day?.checkAfter ?? null;
  assert.ok(checkAfter !== null && checkAfter > THURSDAY, "the day's check lies ahead");
  const afterCheck = new Date(checkAfter.getTime() + HOUR_MS);
  const passes = [
    ["granted", null],
    ["granted", null],
  ];
  assert.deepEqual(before, [["pending_invites_unknown", afterCheck], ...passes]);
  assert.deepEqual(await gate(unknown), {
    refused: "pending_invites_unknown",
    retryAt: afterCheck,
  });

  today = new Date(checkAfter.getTime() + 60_000); // the check due, not made yet
  const nextRun = new Date(today.getTime() + HOUR_MS);
  assert.deepEqual(await answers(unknown, "after"), [
    ["pending_invites_unknown", nextRun],
    ...passes,
  ]);
  assert.equal(await logged(unknown.id, "pending_invites_unknown"), 2);

  // The day's check made, the count unknown again (as a replacement leaves it): the next quota day.
  await app.senderQuotaUsage.update({ where: { id: day?.id ?? "" }, data: { checkedAt: today } });
  assert.deepEqual(await gate(unknown), { refused: "pending_invites_unknown", retryAt: FRIDAY });
});

test("a count checked more than 48 hours ago refuses an invite pending_invites_unknown, by the reservation and by the gate; 48 hours exactly lets it through", async () => {
  const freshFor = 48 * HOUR_MS;
  const stale = await sender("UTC", ALWAYS, {
    pendingInvites: 3,
    pendingInvitesCheckedAt: new Date(THURSDAY.getTime() - freshFor - 1),
  });
  const [invite, message, withdraw] = await answers(stale, "stale");
  assert.equal(invite?.[0], "pending_invites_unknown");
  assert.deepEqual(
    [message, withdraw],
    [
      ["granted", null],
      ["granted", null],
    ],
  );
  assert.equal((await gate(stale))?.refused, "pending_invites_unknown");

  const fresh = await sender("UTC", ALWAYS, {
    pendingInvites: 3,
    pendingInvitesCheckedAt: new Date(THURSDAY.getTime() - freshFor),
  });
  granted(await fresh.send("fresh"));
});

test("each committed invite adds one to the count until the next check; a released invite, a message and a repeat add nothing; at 401 invites stop", async () => {
  const account = await sender("UTC", ALWAYS, {
    pendingInvites: 399,
    pendingInvitesCheckedAt: THURSDAY,
  });
  const first = granted(await account.send("first"));
  await account.commit(first);
  assert.equal(await pending(account.id), 400);
  await account.release(granted(await account.send("released")));
  await account.commit(granted(await account.send("message", "message")));
  await account.commit(first);
  assert.equal(await pending(account.id), 400, "a release, a message and a repeat add nothing");

  const second = granted(await account.send("second"));
  await account.commit(second);
  assert.equal(await pending(account.id), 401);
  const [invite] = await answers(account, "over");
  assert.deepEqual(invite, ["pending_invites_over_limit", FRIDAY]);
});

test("a count made unknown while an invite is reserved, as a replacement makes it, stays unknown at the invite's commit", async () => {
  const account = await sender("UTC", ALWAYS, {
    pendingInvites: 0,
    pendingInvitesCheckedAt: THURSDAY,
  });
  const reserved = granted(await account.send("reserved"));
  const unknown = { pendingInvites: null, pendingInvitesCheckedAt: null };
  await app.senderAccount.update({ where: { id: account.id }, data: unknown });
  await account.commit(reserved);
  assert.equal(await pending(account.id), null);
});

test("remainingToday answers no invite while the count refuses them, the messages and withdrawals as before", async () => {
  const cases = [
    { pendingInvites: 401, pendingInvitesCheckedAt: THURSDAY },
    { pendingInvites: null, pendingInvitesCheckedAt: null },
    { pendingInvites: 0, pendingInvitesCheckedAt: new Date(THURSDAY.getTime() - 49 * HOUR_MS) },
  ];
  for (const settings of cases) {
    const account = await sender("UTC", ALWAYS, settings);
    const left = await account.run(() => remainingToday(account.id));
    assert.equal(left.invites, 0, JSON.stringify(settings));
    assert.ok(left.messages > 0 && left.withdrawals > 0 && left.windowEnd !== null);
  }
  const open = await sender("UTC", ALWAYS, {
    pendingInvites: 0,
    pendingInvitesCheckedAt: THURSDAY,
  });
  assert.ok((await open.run(() => remainingToday(open.id))).invites > 0);
});

test("a warning on the check's list writes no count and pauses the account as a read's does, the read counted and logged with its code; the next check is refused before its call", async () => {
  const account = await sender("UTC", ALWAYS, {
    pendingInvites: null,
    pendingInvitesCheckedAt: null,
  });
  await account.run(() => remainingToday(account.id)); // today's row, its check_after drawn
  const checkAfter = (await account.days())[0]?.checkAfter ?? null;
  assert.ok(checkAfter !== null);
  today = new Date(checkAfter.getTime() + 60_000);
  const details = { reason: "checkpoint" };
  const failed = new AppError(linkedinPort.errors.linkedin_account_disconnected, { details });
  const called: string[] = [];
  const calls: CheckCalls = {
    tenant: (fn) => account.run(fn),
    listPendingInvites: async () => {
      called.push("listPendingInvites");
      return { failed };
    },
    getRelation: async () => {
      called.push("getRelation");
      return { ok: { connected: true, invitationPending: false } };
    },
  };
  const refused = { due: true, refused: "linkedin_account_disconnected" };
  assert.deepEqual(await checkInvites(calls, account.id), refused);
  const row = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.deepEqual(
    [row.healthState, row.pendingInvites, row.pendingInvitesCheckedAt],
    ["checkpoint", null, null],
  );
  const [day] = await account.days();
  assert.deepEqual([day?.readsCommitted, day?.checkedAt], [1, null]);
  const where = { senderAccountId: account.id, kind: "pending_invites" as const };
  const rows = await app.senderActionLog.findMany({ where });
  assert.deepEqual(rows.map(({ outcome }) => outcome).sort(), [
    "linkedin_account_disconnected",
    "reserved",
  ]);

  assert.deepEqual(await checkInvites(calls, account.id), { due: true, refused: "account_paused" });
  assert.deepEqual(called, ["listPendingInvites"]);
});

test("the invites in flight count with the pending ones: at 400 one invite reserved refuses the next, by the reservation, by the gate and in the plan, while its own gate lets it through; at 399 two in flight both go, and a third waits", async () => {
  const at400 = await sender("UTC", ALWAYS, {
    pendingInvites: 400,
    pendingInvitesCheckedAt: THURSDAY,
  });
  const first = granted(await at400.send("first"));
  const [invite] = await answers(at400, "second");
  assert.deepEqual(invite, ["pending_invites_over_limit", FRIDAY]);
  assert.deepEqual(await gate(at400), { refused: "pending_invites_over_limit", retryAt: FRIDAY });
  assert.equal((await at400.run(() => remainingToday(at400.id))).invites, 0);
  assert.equal(await gate(at400, "invite", first), null, "its own gate");
  await at400.commit(first);
  assert.equal(await pending(at400.id), 401);

  const at399 = await sender("UTC", ALWAYS, {
    pendingInvites: 399,
    pendingInvitesCheckedAt: THURSDAY,
  });
  const one = granted(await at399.send("one"));
  const two = granted(await at399.send("two"));
  assert.deepEqual(
    [await gate(at399, "invite", one), await gate(at399, "invite", two)],
    [null, null],
  );
  const [third] = await answers(at399, "third");
  assert.deepEqual(third, ["pending_invites_over_limit", FRIDAY]);
  await at399.commit(one);
  await at399.commit(two);
  assert.equal(await pending(at399.id), 401);
});

test("an invite committed while the check runs is added to the count it writes, whatever day reserved it: yesterday's late commit included", async () => {
  const account = await sender("UTC", ALWAYS, {
    pendingInvites: 5,
    pendingInvitesCheckedAt: new Date(THURSDAY.getTime() - DAY_MS),
  });
  today = new Date(THURSDAY.getTime() - DAY_MS); // Wednesday: reserved, its send outcome open
  const wednesday = granted(await account.send("wednesday"));
  await checkDue(account);
  const { calls } = callsOf(account, {}, () => account.commit(wednesday));
  const answer = await checkInvites(calls, account.id);
  assert.ok("pending" in answer);
  assert.equal(answer.pending, 1, "none listed, one committed during the check");
  assert.equal(await pending(account.id), 1);
});

test("a relation's linkedin_not_found closes its invite, logged with its code, and the check goes on to the next; another error ends the pass and leaves its invite for the next day's check, which skips the closed one", async () => {
  const account = await sender("UTC", ALWAYS);
  const ago = (days: number) => new Date(THURSDAY.getTime() - days * DAY_MS);
  const [gone, next, failing] = await createInvites(account.workspaceId, account.id, [
    { invitedAt: ago(3), providerMemberRef: "member-gone" },
    { invitedAt: ago(2), providerMemberRef: "member-next" },
    { invitedAt: ago(1), providerMemberRef: "member-failing" },
  ]);
  assert.ok(gone !== undefined && next !== undefined && failing !== undefined);
  const { linkedin_not_found, linkedin_provider_error } = linkedinPort.errors;
  const relations = {
    "member-gone": { failed: new AppError(linkedin_not_found) },
    "member-failing": { failed: new AppError(linkedin_provider_error) },
  };
  await checkDue(account);
  const thursday = callsOf(account, relations);
  const answer = await checkInvites(thursday.calls, account.id);
  assert.ok("checked" in answer);
  assert.deepEqual([answer.accepted, answer.checked], [1, 2]);
  assert.deepEqual(thursday.called, [
    "listPendingInvites",
    "getRelation:member-gone",
    "getRelation:member-next",
    "getRelation:member-failing",
  ]);
  const row = (id: string) => app.senderOutreach.findUniqueOrThrow({ where: { id } });
  const closed = await row(gone.id);
  assert.deepEqual([closed.acceptedAt, closed.relationCheckedAt], [null, today]);
  assert.deepEqual((await row(next.id)).acceptedAt, today);
  assert.equal((await row(failing.id)).relationCheckedAt, null);
  const asked = await app.senderActionLog.findMany({
    where: { senderAccountId: account.id, kind: "relation_check" },
  });
  const outcomes = (personId: string) =>
    asked
      .filter((entry) => entry.objectRef === personId)
      .map((entry) => entry.outcome)
      .sort();
  assert.deepEqual(outcomes(gone.personId), ["linkedin_not_found", "reserved"]);
  assert.deepEqual(outcomes(failing.personId), ["linkedin_provider_error", "reserved"]);

  await checkDue(account, new Date(THURSDAY.getTime() + DAY_MS));
  const friday = callsOf(account, relations);
  await checkInvites(friday.calls, account.id);
  assert.deepEqual(friday.called, ["listPendingInvites", "getRelation:member-failing"]);
});

test("an account paired at connected_at gets its count written, and only its invites sent since that pairing are asked about; paired again during the check, it gets no count and the day's check stays due", async () => {
  const account = await sender("UTC", ALWAYS, {
    pendingInvites: 3,
    pendingInvitesCheckedAt: new Date(THURSDAY.getTime() - HOUR_MS),
  });
  const pairedAt = new Date(THURSDAY.getTime() - DAY_MS);
  await app.senderAccount.update({ where: { id: account.id }, data: { connectedAt: pairedAt } });
  await createInvites(account.workspaceId, account.id, [
    { invitedAt: new Date(pairedAt.getTime() - DAY_MS), providerMemberRef: "member-before" },
    { invitedAt: new Date(pairedAt.getTime() + HOUR_MS), providerMemberRef: "member-since" },
  ]);
  await checkDue(account);
  const thursday = callsOf(account);
  const answer = await checkInvites(thursday.calls, account.id);
  assert.ok("pending" in answer);
  assert.deepEqual([answer.pending, answer.accepted], [0, 1]);
  assert.deepEqual(thursday.called, ["listPendingInvites", "getRelation:member-since"]);
  const written = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.deepEqual([written.pendingInvites, written.pendingInvitesCheckedAt], [0, today]);

  await checkDue(account, new Date(THURSDAY.getTime() + DAY_MS));
  const pairedAgain = () =>
    app.senderAccount.update({ where: { id: account.id }, data: { connectedAt: today } });
  const friday = callsOf(account, {}, pairedAgain);
  const refused = { due: true, refused: "linkedin_account_disconnected" };
  assert.deepEqual(await checkInvites(friday.calls, account.id), refused);
  const kept = await app.senderAccount.findUniqueOrThrow({ where: { id: account.id } });
  assert.deepEqual(
    [kept.pendingInvites, kept.pendingInvitesCheckedAt],
    [0, written.pendingInvitesCheckedAt],
  );
  assert.equal((await account.days()).at(-1)?.checkedAt, null);
});

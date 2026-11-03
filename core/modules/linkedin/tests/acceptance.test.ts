// The acceptance rule's measure (beta-p6-020; domain/health/acceptance.ts): acceptanceOf counts the
// account's newest 100 invites at least 7 days old, to the millisecond, and those of them accepted, a
// withdrawn invite as not accepted, with no rate under 100; other accounts' rows and outreach never
// invited are not counted. And the rule's signal for a rate, and its numbers.
import assert from "node:assert/strict";
import test from "node:test";
import { tenantClient } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { acceptanceOf, acceptanceSignal } from "../domain/health/acceptance.ts";
import {
  ACCEPTANCE_MIN,
  ACCEPTANCE_MIN_AGE_DAYS,
  ACCEPTANCE_SAMPLE,
} from "../domain/health/constants.ts";
import { createInvites, createOutreach, useLinkedinClient } from "../testing/index.ts";
import { sender, THURSDAY } from "./fixtures/send.ts";

withTestDb();
useLinkedinClient(asRole("app"));
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The newest instant counted at THURSDAY: 7 days before it, exactly. */
const CUT = new Date(THURSDAY.getTime() - 7 * DAY_MS);

type Sender = Awaited<ReturnType<typeof sender>>;
const measure = (account: Sender, at: Date) =>
  account.run(() => acceptanceOf(tenantClient, account.id, at));
/** `count` instants from `from` back, a minute apart. */
const back = (from: Date, count: number) =>
  Array.from({ length: count }, (_, i) => new Date(from.getTime() - i * MINUTE_MS));

test("the numbers: 20 percent of the last 100 invites at least 7 days old", () => {
  assert.deepEqual([ACCEPTANCE_MIN, ACCEPTANCE_SAMPLE, ACCEPTANCE_MIN_AGE_DAYS], [0.2, 100, 7]);
});

test("acceptanceOf: the newest 100 invites at least 7 days old, to the millisecond; accepted those with accepted_at, a withdrawn one never; a younger invite, another account's and outreach never invited are not counted", async () => {
  const account = await sender();
  const other = await sender("UTC", undefined, { workspaceId: account.workspaceId });
  const accepted = (at: Date) => new Date(at.getTime() + MINUTE_MS);
  // The newest 100: from the cut back, 20 accepted (5 of them withdrawn too), 10 withdrawn alone.
  const newest = back(CUT, 100).map((invitedAt, i) => ({
    invitedAt,
    acceptedAt: i < 20 ? accepted(invitedAt) : null,
    withdrawnAt: (i >= 15 && i < 20) || (i >= 20 && i < 30) ? accepted(invitedAt) : null,
  }));
  // 50 older, every one accepted: outside the newest 100.
  const older = back(new Date(CUT.getTime() - DAY_MS), 50).map((invitedAt) => ({
    invitedAt,
    acceptedAt: accepted(invitedAt),
  }));
  // One a millisecond short of 7 days old, accepted.
  const young = { invitedAt: new Date(CUT.getTime() + 1), acceptedAt: THURSDAY };
  await createInvites(account.workspaceId, account.id, [...older, ...newest, young]);
  const theirs = back(CUT, 100).map((invitedAt) => ({ invitedAt, acceptedAt: THURSDAY }));
  await createInvites(other.workspaceId, other.id, theirs);
  await createOutreach(account.workspaceId, { senderAccountId: account.id }); // a message only

  assert.deepEqual(await measure(account, THURSDAY), { sample: 100, accepted: 15, rate: 0.15 });
});

test("acceptanceOf: under 100 invites at least 7 days old, no rate, whatever is accepted: a millisecond before the newest is 7 days old, 99; none, a sample of 0", async () => {
  const account = await sender();
  assert.deepEqual(await measure(account, THURSDAY), { sample: 0, accepted: 0, rate: null });
  const rows = back(CUT, 100).map((invitedAt) => ({ invitedAt, acceptedAt: THURSDAY }));
  await createInvites(account.workspaceId, account.id, rows);
  assert.deepEqual(await measure(account, THURSDAY), { sample: 100, accepted: 100, rate: 1 });
  const earlier = new Date(THURSDAY.getTime() - 1);
  assert.deepEqual(await measure(account, earlier), { sample: 99, accepted: 99, rate: null });
});

test("acceptanceSignal: under 20 percent at_risk, at it or over recovered, no rate none", () => {
  const cases = [
    [null, null],
    [0, "at_risk"],
    [0.19, "at_risk"],
    [0.2, "recovered"],
    [20 / 100, "recovered"],
    [1, "recovered"],
  ] as const;
  for (const [rate, signal] of cases) assert.equal(acceptanceSignal(rate), signal, String(rate));
});

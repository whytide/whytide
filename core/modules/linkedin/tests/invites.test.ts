// The pending invitations' pure parts (beta-p4-070; domain/invites/pending.ts): which outreach rows
// the day's check asks about, matched against the vendor's list by the invitation's and the
// member's refs; what a relation says of an invite off the list; and the count's refusal.
import assert from "node:assert/strict";
import test from "node:test";
import { PENDING_INVITES_FRESH_MS, PENDING_INVITES_MAX } from "../domain/invites/constants.ts";
import { missedOf, pendingRefusal, relationOutcome } from "../domain/invites/pending.ts";

const row = (
  id: string,
  providerMemberRef: string | null,
  providerInvitationRef: string | null = `invitation-${id}`,
) => ({ id, personId: `per_${id}`, providerMemberRef, providerInvitationRef });
const invite = (memberRef: string, invitationRef = `invitation-of-${memberRef}`) => ({
  invitationRef,
  memberRef,
});

test("a row is missed only when neither its invitation nor its member is on the list; one without a member's ref is left", () => {
  const rows = [
    row("still-pending", "member-a", "invitation-a"),
    row("same-member-new-invitation", "member-b", "invitation-old"),
    row("same-invitation-other-member", "member-c", "invitation-c"),
    row("gone", "member-d", "invitation-d"),
    row("no-invitation-ref", "member-e", null),
    row("no-member-ref", null, "invitation-f"),
  ];
  const pending = [
    invite("member-a", "invitation-a"),
    invite("member-b", "invitation-new"),
    invite("member-z", "invitation-c"),
  ];
  const missed = missedOf(rows, pending).map(({ id }) => id);
  assert.deepEqual(missed, ["gone", "no-invitation-ref"]);
});

test("with nothing pending every row with a member's ref is missed, in the rows' order; with no rows, none", () => {
  const rows = [row("b", "member-b"), row("a", "member-a"), row("x", null)];
  assert.deepEqual(
    missedOf(rows, []).map(({ id }) => id),
    ["b", "a"],
  );
  assert.deepEqual(missedOf([], [invite("member-a")]), []);
});

test("a relation: connected is an acceptance, whatever the invitation; pending is left; neither is gone", () => {
  assert.equal(relationOutcome({ connected: true, invitationPending: false }), "accepted");
  assert.equal(relationOutcome({ connected: true, invitationPending: true }), "accepted");
  assert.equal(relationOutcome({ connected: false, invitationPending: true }), "pending");
  assert.equal(relationOutcome({ connected: false, invitationPending: false }), "gone");
});

test("the count's refusal: unknown with no count or no time, or older than 48 hours; over the limit above 400; else none", () => {
  const at = new Date("2026-10-22T10:00:00Z");
  const fresh = new Date(at.getTime() - PENDING_INVITES_FRESH_MS);
  const stale = new Date(fresh.getTime() - 1);
  const cases = [
    [{ pendingInvites: null, pendingInvitesCheckedAt: at }, "pending_invites_unknown"],
    [{ pendingInvites: 0, pendingInvitesCheckedAt: null }, "pending_invites_unknown"],
    [{ pendingInvites: 0, pendingInvitesCheckedAt: stale }, "pending_invites_unknown"],
    [
      { pendingInvites: PENDING_INVITES_MAX + 1, pendingInvitesCheckedAt: stale },
      "pending_invites_unknown",
    ],
    [
      { pendingInvites: PENDING_INVITES_MAX + 1, pendingInvitesCheckedAt: fresh },
      "pending_invites_over_limit",
    ],
    [{ pendingInvites: PENDING_INVITES_MAX, pendingInvitesCheckedAt: fresh }, null],
    [{ pendingInvites: 0, pendingInvitesCheckedAt: at }, null],
  ] as const;
  for (const [account, refusal] of cases) {
    assert.equal(pendingRefusal(account, at), refusal, JSON.stringify(account));
  }
  assert.equal(PENDING_INVITES_MAX, 400);
  assert.equal(PENDING_INVITES_FRESH_MS, 48 * 3_600_000);
});

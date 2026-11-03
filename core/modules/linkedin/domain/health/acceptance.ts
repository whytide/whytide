// The acceptance rule (README.md "Health"; beta-p6-020; RB-11.3.1, reduced): the account's acceptance
// over its last ACCEPTANCE_SAMPLE connection requests at least ACCEPTANCE_MIN_AGE_DAYS old, the
// platform's own (sender_outreach; the ones its user sent by hand are unknown here), in one query and
// with no provider call; the day's check of the pending invitations (invites/check.ts) applies it as
// its last step, so once a day. Under ACCEPTANCE_MIN it pauses the invites (at_risk), at it or over
// it lifts them: applyHealth moves only a healthy account to at_risk and an at_risk one back, so a
// restricted, checkpoint or disconnected account keeps its state whatever its rate.
import type { TenantClient } from "@whytide/db";
import { applyHealth } from "./apply.ts";
import { ACCEPTANCE_MIN, ACCEPTANCE_MIN_AGE_MS, ACCEPTANCE_SAMPLE } from "./constants.ts";
import type { HealthSignal } from "./states.ts";

/** The rate's numbers, counts only: `rate` is accepted / sample, null under a full sample. */
export type Acceptance = {
  readonly sample: number;
  readonly accepted: number;
  readonly rate: number | null;
};

/**
 * The account's acceptance at `at`: its newest ACCEPTANCE_SAMPLE outreach rows invited at least
 * ACCEPTANCE_MIN_AGE_DAYS before `at`, and those of them accepted. A withdrawn invite counts as not
 * accepted, an acceptance after it included.
 */
export async function acceptanceOf(
  tx: TenantClient,
  accountId: string,
  at: Date,
): Promise<Acceptance> {
  const rows = await tx.senderOutreach.findMany({
    where: {
      senderAccountId: accountId,
      invitedAt: { lte: new Date(at.getTime() - ACCEPTANCE_MIN_AGE_MS) },
    },
    select: { acceptedAt: true, withdrawnAt: true },
    orderBy: [{ invitedAt: "desc" }, { id: "desc" }],
    take: ACCEPTANCE_SAMPLE,
  });
  const sample = rows.length;
  const accepted = rows.filter((row) => row.acceptedAt !== null && row.withdrawnAt === null).length;
  return { sample, accepted, rate: sample < ACCEPTANCE_SAMPLE ? null : accepted / sample };
}

/** The rule's signal: under ACCEPTANCE_MIN at_risk, at it or over recovered; none without a rate. */
export function acceptanceSignal(
  rate: number | null,
): Extract<HealthSignal, "at_risk" | "recovered"> | null {
  if (rate === null) return null;
  return rate < ACCEPTANCE_MIN ? "at_risk" : "recovered";
}

/**
 * The rule at `at`, in the caller's run: the acceptance measured, then its signal through applyHealth
 * (trigger acceptance_rate, the three numbers): at_risk from healthy, with its event and
 * linkedin.account_paused, the owner's mail; recovered from at_risk, with its event and no mail; any
 * other state nothing. The acceptance.
 */
export async function applyAcceptanceRule(
  tx: TenantClient,
  accountId: string,
  at: Date,
): Promise<Acceptance> {
  const acceptance = await acceptanceOf(tx, accountId, at);
  const { sample, accepted, rate } = acceptance;
  const signal = acceptanceSignal(rate);
  if (signal === null || rate === null) return acceptance;
  const metrics = { sample, accepted, rate };
  await applyHealth(tx, accountId, signal, { at, trigger: "acceptance_rate", metrics });
  return acceptance;
}

// The sender's next step (docs/flows.md "The sender", step 1), in the caller's tenant run: the
// account's earliest `scheduled` step placed on today's quota day in its zone whose time is no more
// than MIN_ACTION_GAP_MS behind `at` (one further behind is the plan's to place again), and how long
// to wait for it: until the later of its time and the account's last send plus the gap, so no burst
// follows a stall and no two sends of the account come closer than the gap; a step left `executing`
// counts from its gate's pass (recover.ts lastActionOf, beta-p4-040). Ids, the action and instants
// only, and, for a connection request, whether its person's member id is unknown, which the profile
// read before it finds (beta-p4-030).
import { tenantClient } from "@whytide/db";
import { quotaDay } from "@whytide/platform";
import type { LinkedInAction } from "../constants.ts";
import { MIN_ACTION_GAP_MS } from "../plan/constants.ts";
import { linkedinActionType, linkedinOnly } from "../steps/actions.ts";
import { timeZoneOf } from "../steps/skip.ts";
import { needsProfileRead } from "./profile.ts";
import { lastActionOf } from "./recover.ts";

export type NextStep = {
  readonly stepExecutionId: string;
  readonly personId: string;
  readonly actionType: LinkedInAction;
  /** The time the plan placed, which the claim is conditional on. */
  readonly scheduledFor: string;
  /** 0 when it may be claimed now. */
  readonly waitMs: number;
  /** A connection request whose person has no member id known: its profile is read first. */
  readonly memberRefUnknown: boolean;
};
export type NextAnswer = {
  /** None: the run ends. */
  readonly step: NextStep | null;
  /** The latest executed_at of the account's steps, or a later gate's pass of one in flight. */
  readonly lastActionAt: string | null;
};

/** The account's next step at `at` (the file's header); none for an account linkedin no longer holds. */
export async function nextStep(accountId: string, at: Date): Promise<NextAnswer> {
  const timeZone = await timeZoneOf(accountId);
  if (timeZone === null) return { step: null, lastActionAt: null };
  const last = await lastActionOf(accountId);
  const lastActionAt = last === null ? null : last.toISOString();
  const row = await tenantClient.stepExecution.findFirst({
    where: {
      senderAccountId: accountId,
      status: "scheduled",
      ...linkedinOnly(),
      quotaDay: quotaDay(at, timeZone),
      scheduledFor: { gte: new Date(at.getTime() - MIN_ACTION_GAP_MS) },
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: { id: true, personId: true, actionType: true, scheduledFor: true },
  });
  if (row?.scheduledFor == null) return { step: null, lastActionAt };
  const { id, personId, scheduledFor } = row;
  const actionType = linkedinActionType(row);
  const gapAfter = last === null ? 0 : last.getTime() + MIN_ACTION_GAP_MS;
  const waitMs = Math.max(0, Math.max(scheduledFor.getTime(), gapAfter) - at.getTime());
  const memberRefUnknown = actionType === "invite" && (await needsProfileRead(personId));
  const step = {
    stepExecutionId: id,
    personId,
    actionType,
    scheduledFor: iso(scheduledFor),
    waitMs,
    memberRefUnknown,
  };
  return { step, lastActionAt };
}

const iso = (instant: Date) => instant.toISOString();

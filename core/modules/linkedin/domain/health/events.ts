// The warnings the health events recorded (README.md "Public interface"), in the caller's tenant run:
// each change of an account into restricted or checkpoint, which campaigns' "Done when" report
// (beta-p7-020) counts and lists. Ids, a state, a trigger and an instant: never the event's metrics.
import { tenantClient } from "@whytide/db";
import { instant } from "@whytide/platform";
import { z } from "zod";
import { parseInput } from "../input.ts";
import { type HealthTrigger, WARNING_STATES, type WarningState } from "./states.ts";

/** A warning as recorded: the account, the state it moved to, its trigger, when. */
export type HealthEventRow = {
  readonly id: string;
  readonly senderAccountId: string;
  readonly toState: WarningState;
  readonly trigger: HealthTrigger;
  readonly createdAt: Date;
};

const sinceInput = z.strictObject({ since: instant });

/**
 * The health events whose `to_state` is restricted or checkpoint, created at or after `since`, oldest
 * first, in the run's workspace only. read_input_invalid naming `since` for no instant.
 */
export async function healthEventsSince(input: {
  readonly since: Date | string;
}): Promise<HealthEventRow[]> {
  const { since } = parseInput(sinceInput, input);
  const rows = await tenantClient.senderHealthEvent.findMany({
    where: { toState: { in: [...WARNING_STATES] }, createdAt: { gte: since } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, senderId: true, toState: true, trigger: true, createdAt: true },
  });
  return rows.map(({ id, senderId, toState, trigger, createdAt }) => ({
    id,
    senderAccountId: senderId,
    toState: toState as WarningState,
    trigger,
    createdAt,
  }));
}

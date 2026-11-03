// The fleet breaker (README.md "Health", docs/flows.md "The fleet breaker"; RB-11.3.2, reduced for
// beta): a restriction or a checkpoint on any account stops the connection requests of every account
// of the instance, messages and reads going on. applyHealth trips it in the warning's own run, so the
// account's pause and the instance's stop commit together. The platform's row (global) is read and
// written through the run's client: made when missing, as the operator's first switch makes it, then
// a compare-and-set where invites_paused is false, so two warnings at once trip it once, with one
// control event and one linkedin.invites_paused, whose subscriber mails the operator. A row another
// run made since the compare-and-set found none (READ COMMITTED) is set by a second one. Only the
// operator's `breaker reopen` lifts it (domain/controls/, cli/control.ts).
import { outboxWriter, type TenantClient } from "@whytide/db";
import { currentTenant, newId, publish } from "@whytide/platform";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { now } from "../clock.ts";
import { PLATFORM_STATES } from "../controls/constants.ts";
import { BREAKER_ACTOR, BREAKER_CHANGED_BY } from "./constants.ts";
import type { HealthTrigger } from "./states.ts";

/** The health event of the warning that trips the breaker: its id and its trigger, the pause's reason. */
export type BreakerCause = { readonly id: string; readonly trigger: HealthTrigger };

/**
 * Invites paused on the instance for the warning on the account, in the caller's run, whose
 * transaction `tx` is: whether this call paused them, with its control event and
 * linkedin.invites_paused; false when they were paused already, and nothing more is written.
 */
export async function tripBreaker(
  tx: TenantClient,
  accountId: string,
  healthEvent: BreakerCause,
): Promise<boolean> {
  const at = now();
  const data = {
    invitesPaused: true,
    invitesPausedReason: healthEvent.trigger,
    changedBy: BREAKER_CHANGED_BY,
    changedAt: at,
  };
  const where = { singleton: true, invitesPaused: false };
  let paused = (await tx.linkedinPlatformControl.updateMany({ where, data })).count === 1;
  if (!paused) {
    const row = { id: newId(ids.linkedin_platform_control), ...data };
    const made = await tx.linkedinPlatformControl.createMany({ data: [row], skipDuplicates: true });
    // No row made: another run made one since the update saw none, the operator's first switch
    // say, and its insert held this one until it committed. The update, run again, sees that row.
    paused =
      made.count === 1 ||
      (await tx.linkedinPlatformControl.updateMany({ where, data })).count === 1;
  }
  if (!paused) return false;
  const { workspaceId } = currentTenant();
  const [off, on] = PLATFORM_STATES.invites;
  await tx.linkedinControlEvent.create({
    data: {
      id: newId(ids.linkedin_control_event),
      scope: "platform",
      control: "invites",
      fromState: off,
      toState: on,
      actorType: "system",
      actor: BREAKER_ACTOR,
      reason: healthEvent.trigger,
      targetWorkspaceId: workspaceId,
      senderAccountId: accountId,
      at,
    },
  });
  const payload = { sender_account_id: accountId, health_event_id: healthEvent.id };
  await publish(outboxWriter(tx, workspaceId), events["linkedin.invites_paused"], payload);
  return true;
}

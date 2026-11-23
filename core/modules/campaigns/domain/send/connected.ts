// A connection request whose person is a connection already (connect-already-connected; README.md
// "Acceptance and the first message"; docs/flows.md "Acceptance → the first message"): LinkedIn
// refused the invite as already connected (recover.ts, by linkedin's error map), or the read before
// it said so (profile.ts). Nothing went out, so the step is `skipped` (already_connected), with no
// touch, no campaigns.step_sent, no withdrawal and no acceptance; while its enrollment is live,
// active or paused, the fallback's emails are skipped with the same reason (they go only while a
// request waits), the enrollment ends if nothing is left of it, and its first LinkedIn message is
// due as after an acceptance (../acceptance.ts dueFirstMessage, from `at`). The caller has freed the
// credits first. The person's rows are locked in the order every stop takes: the lead, then the
// enrollment.
import { lockLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { dueFirstMessage, firstMessageOf } from "../acceptance.ts";
import { versionSteps } from "../campaigns/reads.ts";
import { LIVE_ENROLLMENT_STATUSES } from "../constants.ts";
import { fallbackKeys, skipFallback } from "../fallback/fallback.ts";
import { linkedinSenderAccount } from "../steps/actions.ts";
import { checkedCode } from "../steps/codes.ts";
import { STEP_REASON_CODES } from "../steps/constants.ts";
import { endIfDone, lockEnrollment } from "../steps/skip.ts";
import { ALREADY_CONNECTED } from "./constants.ts";

const SYSTEM = { type: "system" } as const;
const EXECUTING = { status: "executing" } as const;
const STEP = {
  enrollmentId: true,
  personId: true,
  senderAccountId: true,
  templateId: true,
  templateVersion: true,
} as const;

/**
 * The claimed connection request `skipped` with already_connected at `at`, while still claimed, and
 * what follows while its enrollment is live (the file's header). Whether it was skipped.
 */
export async function skipConnected(id: string, at: Date): Promise<boolean> {
  const step = await tenantClient.stepExecution.findFirst({
    where: { id, ...EXECUTING },
    select: STEP,
  });
  if (step === null) return false;
  const reason = checkedCode(STEP_REASON_CODES, "skip_reason", ALREADY_CONNECTED);
  const { enrollmentId, personId, templateId } = step;
  await lockLeadStatus(personId);
  await lockEnrollment(tenantClient, enrollmentId);
  const skipped = await tenantClient.stepExecution.updateMany({
    where: { id, ...EXECUTING },
    data: { status: "skipped", skipReason: reason },
  });
  if (skipped.count === 0) return false;
  // An enrollment ended meanwhile, by a reply, a suppression or the owner: nothing follows.
  const live = { id: enrollmentId, status: { in: [...LIVE_ENROLLMENT_STATUSES] } };
  if ((await tenantClient.enrollment.count({ where: live })) === 0) return true;
  const versioned = (await versionSteps(templateId, step.templateVersion)) ?? [];
  await skipFallback(tenantClient, enrollmentId, fallbackKeys(versioned), reason);
  if (await endIfDone(tenantClient, { enrollmentId, personId, templateId }, at, SYSTEM)) {
    return true;
  }
  const firstMessage = firstMessageOf(versioned);
  const message =
    firstMessage === undefined
      ? null
      : await tenantClient.stepExecution.findFirst({
          where: { enrollmentId, stepKey: firstMessage },
          select: { id: true, status: true, dueAt: true },
        });
  const senderAccountId = linkedinSenderAccount({ id, senderAccountId: step.senderAccountId });
  await dueFirstMessage(tenantClient, message ?? undefined, senderAccountId, at);
  return true;
}

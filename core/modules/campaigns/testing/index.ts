// campaigns' test hooks (README.md "Testing"), `@whytide/campaigns/testing`, for tests only:
// useClock(() => date) sets the time the plan and the counts read, and useRandom(() => number) the
// numbers its times are drawn from; undefined puts the system's back. createEnrollment writes an
// enrollment and its steps straight to the tables, in the states and at the times given, as campaigns
// and its sender leave them, for the api's counts test and the web's e2e seed (beta-p7-010); on the
// client given, else on asRole("app") of @whytide/db/testing, so the test file calls withTestDb()
// first. useGateFreshMs(ms) sets how long the sender's gate before the call holds (beta-p4-040);
// undefined puts GATE_FRESH_MS back. useProfileReadWait(ms) shortens the wait between a profile
// read and its connection request (beta-p4-030). Both are refused outside APP_ENV=test.
import type { TenantClient } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { newId, platformIds } from "@whytide/platform";
import type { ActionType, EnrollmentStatus, ExitReason, StepStatus } from "../domain/constants.ts";
import { TEMPLATE_ID, TEMPLATE_STEPS, TEMPLATE_VERSION } from "../domain/template/constants.ts";
import { idempotencyKey, stepTemplateHash } from "../domain/template/keys.ts";
import { ids } from "../ids.ts";

export { useClock, useRandom } from "../domain/clock.ts";
export { useGateFreshMs } from "../domain/send/fresh.ts";
export { useProfileReadWait } from "../domain/send/wait.ts";

type Client = Pick<TenantClient, "enrollment" | "stepExecution">;

/** A step as a test seeds it, by its key; each column but the status has a default. */
export type SeededStep = {
  /** A key of the template, or another with its `actionType` (a withdrawal's, beta-p4-060). */
  readonly stepKey: string;
  /** The template's action for the key unless given. */
  readonly actionType?: ActionType;
  readonly status: StepStatus;
  readonly dueAt?: Date | null;
  readonly scheduledFor?: Date | null;
  readonly executedAt?: Date | null;
  /** The connection request's detection time (beta-p4-050). */
  readonly acceptedAt?: Date | null;
  readonly skipReason?: string | null;
  readonly errorCode?: string | null;
};

/** An enrollment as a test seeds it; each column has a default that the table's CHECKs accept. */
export type SeededEnrollment = {
  readonly workspaceId: string;
  readonly personId: string;
  /** Null for one that exited as it was made, without a sender: it holds no step. */
  readonly senderAccountId: string | null;
  /** `active` unless given. */
  readonly status?: EnrollmentStatus;
  /** An exited one's: `removed` unless given. */
  readonly exitReason?: ExitReason;
  readonly exitDetail?: string | null;
  /** Now unless given, for one with a sender; null for one without. */
  readonly startedAt?: Date | null;
  /** An ended one's (`replied`, `completed`, `exited`): now unless given. */
  readonly endedAt?: Date;
  readonly steps?: readonly SeededStep[];
};

/**
 * The enrollment, then its steps in the order given, written straight to the tables: each step with
 * the template's position, hash and idempotency key for its key, so a person's step is claimed once
 * (the partial key). Their ids.
 */
export async function createEnrollment(
  input: SeededEnrollment,
  client: Client = asRole("app"),
): Promise<{ id: string; stepIds: string[] }> {
  const { workspaceId, personId, senderAccountId, status = "active", steps = [] } = input;
  const at = new Date();
  const id = newId(ids.enrollment);
  const template = { templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION };
  await client.enrollment.create({
    data: {
      ...{ id, workspaceId, personId, senderAccountId, ...template, status },
      exitReason: status === "exited" ? (input.exitReason ?? "removed") : null,
      exitDetail: input.exitDetail ?? null,
      sourceEventId: newId(platformIds.outbox_entry),
      startedAt:
        input.startedAt !== undefined ? input.startedAt : senderAccountId === null ? null : at,
      endedAt: status === "active" ? null : (input.endedAt ?? at),
    },
  });
  const stepIds: string[] = [];
  for (const [index, step] of steps.entries()) {
    if (senderAccountId === null)
      throw new Error("createEnrollment: a step needs a sender account");
    const known = TEMPLATE_STEPS.find(({ stepKey }) => stepKey === step.stepKey);
    const actionType = step.actionType ?? known?.action;
    if (actionType === undefined) throw new Error("createEnrollment: a step outside the template");
    const hash = known === undefined ? step.stepKey : stepTemplateHash(known);
    const parts = { workspaceId, personId, templateId: TEMPLATE_ID, stepTemplateHash: hash };
    const stepId = newId(ids.step_execution);
    await client.stepExecution.create({
      data: {
        ...{ id: stepId, workspaceId, enrollmentId: id, personId, senderAccountId, ...template },
        ...{ stepKey: step.stepKey, actionType, status: step.status },
        position: known?.position ?? TEMPLATE_STEPS.length + index + 1,
        stepTemplateHash: hash,
        idempotencyKey: idempotencyKey(parts),
        dueAt: step.dueAt ?? null,
        scheduledFor: step.scheduledFor ?? null,
        executedAt: step.executedAt ?? null,
        acceptedAt: step.acceptedAt ?? null,
        skipReason: step.skipReason ?? null,
        errorCode: step.errorCode ?? null,
      },
    });
    stepIds.push(stepId);
  }
  return { id, stepIds };
}

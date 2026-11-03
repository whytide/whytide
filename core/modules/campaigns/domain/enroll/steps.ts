// The step executions of a new enrollment (README.md "The template"): one row per step of the
// template, all planned, each with its hash and its key; the connection request due at once, the
// others with no due_at until their anchor happens (the acceptance, the previous message's send).
import type { Prisma } from "@whytide/db";
import { newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { TEMPLATE_ID, TEMPLATE_STEPS, TEMPLATE_VERSION } from "../template/constants.ts";
import { idempotencyKey, stepTemplateHash } from "../template/keys.ts";

/** The enrollment the steps belong to: its id, its workspace, its person and its sender. */
export type EnrolledPerson = {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  readonly senderAccountId: string;
};

/** The rows to write for the enrollment, made at `now`. */
export function plannedSteps(
  enrollment: EnrolledPerson,
  now: Date,
): Prisma.StepExecutionCreateManyInput[] {
  const { workspaceId, personId, senderAccountId } = enrollment;
  return TEMPLATE_STEPS.map((step) => {
    const hash = stepTemplateHash(step);
    const key = { workspaceId, personId, templateId: TEMPLATE_ID, stepTemplateHash: hash };
    return {
      id: newId(ids.step_execution),
      ...{ workspaceId, enrollmentId: enrollment.id, personId, senderAccountId },
      ...{ templateId: TEMPLATE_ID, templateVersion: TEMPLATE_VERSION },
      ...{ stepKey: step.stepKey, position: step.position, actionType: step.action },
      ...{ stepTemplateHash: hash, idempotencyKey: idempotencyKey(key), status: "planned" },
      dueAt: step.delay.anchor === "enrollment" ? now : null,
    };
  });
}

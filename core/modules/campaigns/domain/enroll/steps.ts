// The step executions of a new enrollment (README.md "Enrolling"): one row per step of the campaign
// version it joins (beta's template, as the seeded campaign's version 1, unless given), all planned,
// each with the version's hash and its key; the connection request due at once, the others with no
// due_at until their anchor happens (the acceptance, the previous step's send). A LinkedIn step
// carries the sender account; an email step none, its mailbox coming with its sender (gamma-p4-010).
import type { Prisma } from "@whytide/db";
import { newId } from "@whytide/platform";
import { ids } from "../../ids.ts";
import { type CampaignVersion, SEEDED_VERSION } from "../campaigns/reads.ts";
import { idempotencyKey } from "../template/keys.ts";

/** The enrollment the steps belong to: its id, its workspace, its person and its sender. */
export type EnrolledPerson = {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  readonly senderAccountId: string;
};

/** The rows to write for the enrollment in the version, made at `now`. */
export function plannedSteps(
  enrollment: EnrolledPerson,
  now: Date,
  version: CampaignVersion = SEEDED_VERSION,
): Prisma.StepExecutionCreateManyInput[] {
  const { workspaceId, personId, senderAccountId } = enrollment;
  const { keyRef: templateId, versionNo: templateVersion } = version;
  return version.steps.map((step) => {
    const hash = step.stepTemplateHash;
    const key = { workspaceId, personId, templateId, stepTemplateHash: hash };
    return {
      id: newId(ids.step_execution),
      ...{ workspaceId, enrollmentId: enrollment.id, personId },
      senderAccountId: step.channel === "email" ? null : senderAccountId,
      ...{ templateId, templateVersion },
      ...{ stepKey: step.stepKey, position: step.position, actionType: step.action },
      ...{ stepTemplateHash: hash, idempotencyKey: idempotencyKey(key), status: "planned" },
      dueAt: step.delay.anchor === "enrollment" ? now : null,
    };
  });
}

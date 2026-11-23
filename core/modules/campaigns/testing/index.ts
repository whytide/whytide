// campaigns' test hooks (README.md "Testing"), `@whytide/campaigns/testing`, for tests only:
// useClock(() => date) sets the time the plan and the counts read, and useRandom(() => number) the
// numbers its times are drawn from; undefined puts the system's back. createEnrollment writes an
// enrollment and its steps straight to the tables, in the states and at the times given, as campaigns
// and its sender leave them, for the api's counts test and the web's e2e seed (beta-p7-010); on the
// client given, else on asRole("app") of @whytide/db/testing, so the test file calls withTestDb()
// first; in the campaign given, with the reply label as gamma-p4-050 leaves it, for the funnel's
// (gamma-p6-080). useGateFreshMs(ms) sets how long the sender's gate before the call holds
// (beta-p4-040); undefined puts GATE_FRESH_MS back. useProfileReadWait(ms) shortens the wait
// between a profile read and its connection request (beta-p4-030). Both are refused outside
// APP_ENV=test.
// createDraftCampaign makes a draft through createCampaign, for the api's launch test and the web's
// e2e seed (gamma-p3-050), the latter inside its request's tenant run (gamma-p3-051).
// setCampaignActive sets a draft `active` as a launch leaves it, in the stead of launchCampaign,
// whose checks are its own tests' (gamma-p3-065); createAgentCampaign makes an agent's campaign as
// the subscriber to playbooks.playbook_created does, in the worker's stead, for the web's e2e seed.
// useCampaignsClient(client) sets the `app` client the approval mode's route opens its own runs on,
// undefined the process's (gamma-p4-070); setReviewLock ends or moves a campaign's lock, in the
// stead of the days going by, for the web's e2e seed and the api's test.
import { type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import {
  currentTenant,
  insideTenantRun,
  newId,
  platformIds,
  servicePrincipal,
} from "@whytide/platform";
import { makeAgentCampaign } from "../domain/campaigns/agent.ts";
import { createCampaign } from "../domain/campaigns/commands.ts";
import { campaignOfPlaybook } from "../domain/campaigns/reads.ts";
import type { SequenceInput } from "../domain/campaigns/sequence.ts";
import type { ActionType, EnrollmentStatus, ExitReason, StepStatus } from "../domain/constants.ts";
import { TEMPLATE_ID, TEMPLATE_STEPS, TEMPLATE_VERSION } from "../domain/template/constants.ts";
import { idempotencyKey, stepTemplateHash } from "../domain/template/keys.ts";
import { ids } from "../ids.ts";

export { useClient as useCampaignsClient } from "../domain/approval-mode/client.ts";
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
  /** `active` unless given; a `paused` one is paused by a member, until `pausedUntil` if given. */
  readonly status?: EnrollmentStatus;
  readonly pausedUntil?: Date | null;
  /** An exited one's: `removed` unless given. */
  readonly exitReason?: ExitReason;
  readonly exitDetail?: string | null;
  /** Now unless given, for one with a sender; null for one without. */
  readonly startedAt?: Date | null;
  /** An ended one's (`replied`, `completed`, `exited`): now unless given. */
  readonly endedAt?: Date;
  /** Its campaign's key_ref and version: the seeded campaign's version 1 unless given. */
  readonly templateId?: string;
  readonly templateVersion?: number;
  /** The reply label last acted on and its reply's instant, set together (gamma-p4-050). */
  readonly reply?: { readonly label: string; readonly at: Date };
  readonly steps?: readonly SeededStep[];
};

/**
 * The enrollment, then its steps in the order given, written straight to the tables: each step with
 * the template's position, hash and idempotency key for its key, so a person's step is claimed once
 * (the partial key); an email step without the sender account, as the CHECK has it. Their ids.
 */
export async function createEnrollment(
  input: SeededEnrollment,
  client: Client = asRole("app"),
): Promise<{ id: string; stepIds: string[] }> {
  const { workspaceId, personId, senderAccountId, status = "active", steps = [] } = input;
  const at = new Date();
  const id = newId(ids.enrollment);
  const templateId = input.templateId ?? TEMPLATE_ID;
  const template = { templateId, templateVersion: input.templateVersion ?? TEMPLATE_VERSION };
  await client.enrollment.create({
    data: {
      ...{ id, workspaceId, personId, senderAccountId, ...template, status },
      exitReason: status === "exited" ? (input.exitReason ?? "removed") : null,
      exitDetail: input.exitDetail ?? null,
      sourceEventId: newId(platformIds.outbox_entry),
      startedAt:
        input.startedAt !== undefined ? input.startedAt : senderAccountId === null ? null : at,
      endedAt: status === "active" || status === "paused" ? null : (input.endedAt ?? at),
      pausedReason: status === "paused" ? "user" : null,
      pausedUntil: status === "paused" ? (input.pausedUntil ?? null) : null,
      replyLabel: input.reply?.label ?? null,
      replyLabelAt: input.reply?.at ?? null,
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
    const parts = { workspaceId, personId, templateId, stepTemplateHash: hash };
    const stepId = newId(ids.step_execution);
    await client.stepExecution.create({
      data: {
        ...{ id: stepId, workspaceId, enrollmentId: id, personId, ...template },
        senderAccountId: actionType === "email" ? null : senderAccountId,
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

/**
 * A draft campaign made by createCampaign: in the caller's tenant run when one is open, which must be
 * the workspace's (the e2e api's route, in its request's run), else in a run of the workspace of its
 * own, on the client given, else on asRole("app"). The steps given, else the warm-signal default, as
 * its version 1; its id.
 */
export async function createDraftCampaign(
  input: {
    readonly workspaceId: string;
    readonly ownerUserId: string;
    readonly name: string;
    readonly steps?: readonly SequenceInput[];
  },
  client?: PrismaClient,
): Promise<{ id: string }> {
  const { workspaceId, ownerUserId, name, steps } = input;
  const make = () => createCampaign({ name, steps, ownerUserId, createdBy: ownerUserId });
  const made = await inWorkspaceRun(workspaceId, make, client);
  return { id: made.campaignId };
}

/**
 * The agent's campaign made as the subscriber to playbooks.playbook_created makes it (the agent's
 * owner given as the event carries it), or the one it has: in the caller's tenant run when one is
 * open, which must be the workspace's, else in a run of its own, on the client given, else on
 * asRole("app"). Its id; an agent the workspace does not hold is a developer's mistake.
 */
export async function createAgentCampaign(
  input: {
    readonly workspaceId: string;
    readonly playbookId: string;
    readonly ownerUserId: string;
  },
  client?: PrismaClient,
): Promise<{ id: string }> {
  const { workspaceId, playbookId, ownerUserId } = input;
  return inWorkspaceRun(
    workspaceId,
    async () => {
      await makeAgentCampaign({ playbookId, ownerUserId });
      const campaign = await campaignOfPlaybook(playbookId);
      if (campaign === null) throw new Error("createAgentCampaign: no such agent");
      return { id: campaign.id };
    },
    client,
  );
}

/** `fn` in the caller's run, which must be the workspace's, else in a run of the workspace's own. */
async function inWorkspaceRun<T>(
  workspaceId: string,
  fn: () => Promise<T>,
  client: PrismaClient | undefined,
): Promise<T> {
  if (insideTenantRun()) {
    if (currentTenant().workspaceId !== workspaceId) {
      throw new Error("campaigns' testing: the run open is another workspace's");
    }
    return fn();
  }
  const context = { workspaceId, principal: servicePrincipal("campaigns_testing") };
  return withTenant(context, fn, { client: client ?? asRole("app") });
}

/**
 * The workspace's draft campaign `active`, launched now, as launchCampaign leaves one, written
 * straight to the table, on the client given, else on asRole("app"); a campaign that is not a draft
 * of the workspace's is a developer's mistake.
 */
export async function setCampaignActive(
  input: { readonly workspaceId: string; readonly campaignId: string },
  client: Pick<TenantClient, "campaign"> = asRole("app"),
): Promise<void> {
  const where = { id: input.campaignId, workspaceId: input.workspaceId, status: "draft" } as const;
  const launched = { status: "active", launchedAt: new Date() } as const;
  const { count } = await client.campaign.updateMany({ where, data: launched });
  if (count !== 1) throw new Error("setCampaignActive: not a draft of the workspace's");
}

/**
 * The end of the workspace's campaign's review_everything lock moved to `lockedUntil`, as the days
 * going by leave it (gamma-p4-070), written straight to the table, on the client given, else on
 * asRole("app"); a campaign the workspace lacks is a developer's mistake.
 */
export async function setReviewLock(
  input: { readonly workspaceId: string; readonly campaignId: string; readonly lockedUntil: Date },
  client: Pick<TenantClient, "campaign"> = asRole("app"),
): Promise<void> {
  const where = { id: input.campaignId, workspaceId: input.workspaceId } as const;
  const data = { reviewLockedUntil: input.lockedUntil };
  const { count } = await client.campaign.updateMany({ where, data });
  if (count !== 1) throw new Error("setReviewLock: not a campaign of the workspace's");
}

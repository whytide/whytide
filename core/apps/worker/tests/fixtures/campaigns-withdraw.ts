// The withdrawal's fixture (tests/campaigns-withdraw.test.ts, tests/safety/withdrawal.test.ts), on
// the sender's (campaigns-sender.ts): a lead whose connection request went out some days ago, left as
// the sender leaves it (the step `succeeded`, the invitation pending on the fake unless it is gone,
// linkedin's outreach row with its ref, the touch); the workspace's withdrawal run through Temporal;
// the clocks moved to an instant; and what the tests read back.
import { randomUUID } from "node:crypto";
import {
  app,
  contacts,
  DAY_MS,
  fake,
  linkedin,
  now,
  runLoaded,
  type Sender,
  skip,
} from "./campaigns-sender.ts";

export type Invited = Awaited<ReturnType<Sender["lead"]>> & {
  readonly connect: string;
  readonly sentAt: Date;
};

/**
 * A lead of `s` whose connection request went out `daysAgo` days before now() (the header), its
 * enrollment started then; `gone`: the invitation is no longer pending (declined, or withdrawn by
 * hand), so a withdrawal finds none.
 */
export async function invited(
  s: Sender,
  slug: string,
  daysAgo: number,
  options: { gone?: boolean } = {},
): Promise<Invited> {
  const lead = await s.lead(slug);
  const connect = lead.steps.connect as string;
  const sentAt = new Date(now().getTime() - daysAgo * DAY_MS);
  const { idempotencyKey } = await app.stepExecution.findUniqueOrThrow({ where: { id: connect } });
  const { invitationRef } = options.gone
    ? { invitationRef: `fake-invitation-${randomUUID()}` }
    : await fake.sendInvite({
        providerAccountRef: s.ref,
        memberRef: lead.memberRef,
        idempotencyKey,
      });
  await app.enrollment.update({ where: { id: lead.enrollmentId }, data: { startedAt: sentAt } });
  await app.stepExecution.update({
    where: { id: connect },
    data: { status: "succeeded", attempt: 1, executedAt: sentAt },
  });
  const refs = { personId: lead.personId, providerMemberRef: lead.memberRef };
  const { id } = await linkedin.createOutreach(s.workspaceId, {
    senderAccountId: s.accountId,
    ...refs,
  });
  await app.senderOutreach.update({
    where: { id },
    data: { providerInvitationRef: invitationRef, invitedAt: sentAt, lastStepExecutionId: connect },
  });
  await s.run(() => contacts.recordTouch(lead.personId, sentAt));
  return { ...lead, connect, sentAt };
}

/** The workspace's withdrawal run, campaigns_withdraw, through Temporal. */
export const withdrawRun = (s: Sender) =>
  runLoaded<{ opened: number }>("campaigns_withdraw", { workspaceId: s.workspaceId });

/** The fake's withdrawal calls. */
export const withdrawals = () =>
  fake.recordedCalls.filter(({ method }) => method === "withdrawInvite");

/** A withdraw step as the tests read it. */
export type WithdrawRow = {
  readonly id: string;
  readonly stepKey: string;
  readonly position: number;
  readonly actionType: string;
  readonly status: string;
  readonly personId: string;
  readonly senderAccountId: string | null;
  readonly templateId: string;
  readonly stepTemplateHash: string;
  readonly idempotencyKey: string;
  readonly approvalItemId: string | null;
  readonly draftId: string | null;
  readonly dueAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly executedAt: Date | null;
  readonly errorCode: string | null;
  readonly skipReason: string | null;
};

/** The enrollment's withdraw steps. */
export const withdrawOf = (enrollmentId: string): Promise<WithdrawRow[]> =>
  app.stepExecution.findMany({ where: { enrollmentId, stepKey: "withdraw" } });

/** campaigns' and linkedin's clocks moved to `at`. */
export const moveTo = (at: Date): void => skip(at.getTime() - now().getTime());

type Outcome = readonly [string, string | null];

/** The enrollment's status and exit reason, and its steps' statuses and reasons by key. */
export async function endOf(
  enrollmentId: string,
): Promise<{ enrollment: Outcome; steps: Record<string, Outcome> }> {
  const enrollment = await app.enrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  const steps = await app.stepExecution.findMany({ where: { enrollmentId } });
  const byKey = Object.fromEntries(
    steps.map((row): [string, Outcome] => [
      row.stepKey,
      [row.status, row.skipReason ?? row.errorCode],
    ]),
  );
  return { enrollment: [enrollment.status, enrollment.exitReason], steps: byKey };
}

/** The person's lead's outreach status. */
export const leadOf = async (personId: string): Promise<string> =>
  (await app.lead.findUniqueOrThrow({ where: { personId } })).outreachStatus;

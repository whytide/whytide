// The owner's resume after a cool-down (README.md "Health"; beta-p6-040, RB-11.3.1 R5) and the
// account's health as its card reads it, each in the request's tenant run. The api never opens the
// reference, so the resume wants the worker's status read ("Check status"); the account restarts at
// half its targets and today's send limits never rise; the fleet breaker stays as it is.
import { tenantClient } from "@whytide/db";
import { AppError, quotaDay } from "@whytide/platform";
import { linkedinPort } from "@whytide/providers";
import { errors } from "../../errors.ts";
import type { HealthResponse } from "../../schemas/health.ts";
import type { SenderAccountStatus } from "../accounts.ts";
import { random } from "../clock.ts";
import { readControls } from "../controls/controls.ts";
import { lockDayInUse } from "../quota/days.ts";
import { lowerDayLimits } from "../quota/limits.ts";
import { halvedTargets } from "../ramp/ramp.ts";
import { acceptanceOf } from "./acceptance.ts";
import { applyHealth, type HealthMetrics, lockAccount } from "./apply.ts";
import {
  COOLDOWN_MS,
  HEALTH_EVENTS_SHOWN,
  RESUME_REFUSALS,
  RESUME_STATUS_MAX_AGE_MS,
} from "./constants.ts";
import { COOLDOWN_STATES, type HealthState } from "./states.ts";

export type ResumeRefusal = (typeof RESUME_REFUSALS)[number];
/** What the refusals read of the account. */
export type ResumeAccount = {
  readonly ownerUserId: string;
  readonly healthState: HealthState;
  readonly pausedUntil: Date | null;
  readonly status: SenderAccountStatus;
  readonly statusCheckedAt: Date | null;
  readonly connectedAt: Date | null;
};
type Times = "since" | "pausedUntil" | "statusCheckedAt" | "pendingInvitesCheckedAt";
type EventView = Omit<HealthResponse["events"][number], "at"> & { readonly at: Date };
/** The account's health as its card reads it (schemas/health.ts), its times as dates. */
export type HealthView = Omit<HealthResponse, Times | "events"> & {
  readonly [time in Times]: Date | null;
} & { readonly events: EventView[] };

const CODES: Readonly<Record<ResumeRefusal, string>> = Object.freeze({
  not_account_owner: errors.not_account_owner,
  account_not_paused: errors.account_not_paused,
  cooldown_active: errors.cooldown_active,
  linkedin_account_disconnected: linkedinPort.errors.linkedin_account_disconnected,
  reconnect_required: errors.reconnect_required,
  status_check_required: errors.status_check_required,
});
const COLUMNS = {
  ownerUserId: true,
  healthState: true,
  pausedUntil: true,
  status: true,
  statusCheckedAt: true,
  connectedAt: true,
  timeZone: true,
  inviteTarget: true,
  messageTarget: true,
  pendingInvites: true,
  pendingInvitesCheckedAt: true,
} as const;
const NEWEST_FIRST = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * Why `userId` cannot resume the account at `at`, in this order, or null: not its owner; its health
 * neither restricted nor checkpoint; its cool-down not over, or its end unknown; its status not
 * `connected`; a checkpoint with no pairing since the latest warning (connected_at not after
 * paused_until less COOLDOWN_MS: a warning on a cool-down moves its end, not health_changed_at, so
 * each checkpoint wants its own reconnect); its status not checked after the cool-down's end, or
 * more than RESUME_STATUS_MAX_AGE_MINUTES before `at`. Fails closed on a time the row lacks.
 */
export function resumeRefusal(
  account: ResumeAccount,
  userId: string,
  at: Date,
): ResumeRefusal | null {
  if (account.ownerUserId !== userId) return "not_account_owner";
  if (!COOLDOWN_STATES.includes(account.healthState)) return "account_not_paused";
  const end = account.pausedUntil;
  if (end === null || at < end) return "cooldown_active";
  if (account.status !== "connected") return "linkedin_account_disconnected";
  const warned = new Date(end.getTime() - COOLDOWN_MS);
  if (account.healthState === "checkpoint" && !after(account.connectedAt, warned)) {
    return "reconnect_required";
  }
  const checked = account.statusCheckedAt;
  if (checked === null || !after(checked, end)) return "status_check_required";
  return at.getTime() - checked.getTime() > RESUME_STATUS_MAX_AGE_MS
    ? "status_check_required"
    : null;
}

/**
 * The owner's resume at `at`, the account's row locked first, then the day's: refused as
 * resumeRefusal says, nothing written, cooldown_active with `details.pausedUntil`; else the targets
 * halved with ramp_updated_on today, today's send limits lowered when its row exists, `healthy`
 * through applyHealth (`resumed`, trigger manual, acknowledged by the owner: no mail), and every
 * pausing event still open acknowledged by the owner. The fleet breaker is left as it is.
 */
export async function resumeAccount(userId: string, accountId: string, at: Date): Promise<void> {
  if ((await lockAccount(tenantClient, accountId)) === null) {
    throw new AppError(errors.sender_account_not_found);
  }
  const account = await tenantClient.senderAccount.findFirstOrThrow({
    where: { id: accountId },
    select: COLUMNS,
  });
  const refused = resumeRefusal(account, userId, at);
  if (refused === "cooldown_active") {
    const details = { pausedUntil: account.pausedUntil?.toISOString() ?? null };
    throw new AppError(errors.cooldown_active, { details });
  }
  if (refused !== null) throw new AppError(CODES[refused]);
  const targets = halvedTargets(account);
  const rampUpdatedOn = quotaDay(at, account.timeZone);
  await tenantClient.senderAccount.update({
    where: { id: accountId },
    data: { ...targets, rampUpdatedOn },
  });
  const day = await lockDayInUse({ id: accountId, timeZone: account.timeZone }, at);
  if (day !== null) {
    const data = lowerDayLimits(day, targets, random);
    await tenantClient.senderQuotaUsage.update({ where: { id: day.id }, data });
  }
  const cause = { at, trigger: "manual", acknowledgedBy: userId } as const;
  await applyHealth(tenantClient, accountId, "resumed", cause);
  await tenantClient.senderHealthEvent.updateMany({
    where: { senderId: accountId, ackRequired: true, acknowledgedAt: null },
    data: { acknowledgedBy: userId, acknowledgedAt: at },
  });
}

/**
 * The account's health for `userId` at `at`, in the request's tenant run: sender_account_not_found
 * for none in the workspace. The trigger and the time are the latest event's that moved the account
 * into its state (a third error's event changes no state); the acceptance is acceptanceOf's.
 */
export async function readHealth(userId: string, accountId: string, at: Date): Promise<HealthView> {
  const account = accountId
    ? await tenantClient.senderAccount.findFirst({ where: { id: accountId }, select: COLUMNS })
    : null;
  if (account === null) throw new AppError(errors.sender_account_not_found);
  const state = account.healthState;
  const change = await tenantClient.senderHealthEvent.findFirst({
    where: { senderId: accountId, toState: state, NOT: { fromState: state } },
    orderBy: NEWEST_FIRST,
    select: { trigger: true, createdAt: true },
  });
  const events = await tenantClient.senderHealthEvent.findMany({
    where: { senderId: accountId },
    orderBy: NEWEST_FIRST,
    take: HEALTH_EVENTS_SHOWN,
  });
  const refused = resumeRefusal(account, userId, at);
  return {
    state,
    trigger: change?.trigger ?? null,
    since: change?.createdAt ?? null,
    pausedUntil: account.pausedUntil,
    status: account.status,
    statusCheckedAt: account.statusCheckedAt,
    canResume: refused === null,
    resumeBlockedBy: refused,
    invitesPaused: (await readControls()).platform.invitesPaused,
    pendingInvites: account.pendingInvites,
    pendingInvitesCheckedAt: account.pendingInvitesCheckedAt,
    acceptance: await acceptanceOf(tenantClient, accountId, at),
    events: events.map((event) => ({
      id: event.id,
      from: event.fromState,
      to: event.toState,
      trigger: event.trigger,
      metrics: metricsOf(event.metrics),
      at: event.createdAt,
      acknowledged: event.acknowledgedAt !== null,
    })),
  };
}

/** Whether `time` is later than `than`; false when either is unknown. */
const after = (time: Date | null, than: Date | null): boolean =>
  time !== null && than !== null && time > than;

/** An event's metrics, its numbers and codes only: anything else in the column is left out. */
function metricsOf(value: unknown): HealthMetrics {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const kept = Object.entries(value).filter(
    (entry): entry is [string, number | string] =>
      typeof entry[1] === "number" || typeof entry[1] === "string",
  );
  return Object.fromEntries(kept);
}

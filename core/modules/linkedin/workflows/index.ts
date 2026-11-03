// The module's workflows, activities and schedule, which the worker host registers
// (core/apps/worker/README.md "Modules"; README.md "Worker"): linkedin_refresh_account, one account's
// status on a Refresh status press (events.ts), and linkedin_status_refresh, global and hourly, every
// account with a reference, workspace by workspace, each through the activity linkedin_refresh_status,
// which also stores the account's member id's hash (domain/disclosure/member.ts), then
// linkedin_check_invites, the day's check of its pending invitations (invites.ts); the activities
// linkedin_read_post_engagers and linkedin_read_profile, the engager and profile reads a signal run
// calls by name, the account read again just before each call, each error's health in the run that
// logs it (domain/health/); linkedin_notify, the
// owner's mail about a health event, or the operator's about the fleet breaker's trip, through the
// activity linkedin_mail_health; the daily job's workflows and schedule, with the activities of
// daily.ts; and onWorkerStart, which keeps the host's logger.
import { json } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  AppError,
  createLogger,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  isAppError,
  type Logger,
  workflowInput,
} from "@whytide/platform";
import {
  type AccountStatus,
  filesConfig,
  filesPort,
  getAdapter,
  linkedinPort,
} from "@whytide/providers";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import { findAccount, type SenderAccountStatus } from "../domain/accounts.ts";
import { countAction, logAction, outcomeOf } from "../domain/action-log/log.ts";
import { now } from "../domain/clock.ts";
import { readControls } from "../domain/controls/controls.ts";
import { memberHash } from "../domain/hash.ts";
import { type HealthMailResult, mailHealthEvent, mailOperator } from "../domain/health/mail.ts";
import { afterPortError } from "../domain/health/signals.ts";
import { linkedin } from "../domain/provider.ts";
import { effectOf, pauseAccount, retryAfterOf } from "../domain/send/outcome.ts";
import { type ReadCallRefusal, readCallRefusal } from "../domain/send/state.ts";
import { setStatus } from "../domain/status.ts";
import { errors } from "../errors.ts";
import type { EngagersPage, EngagersRefused, ReadPostEngagers } from "../schemas/engagers.ts";
import {
  type ProfileRead,
  type ProfileRefused,
  profileRequestFile,
  type ReadProfile,
} from "../schemas/profile.ts";
import type { ActionOutcome } from "../schemas/quota.ts";
import { ALERT_EMAIL_MISSING, DAILY_CRON, DAILY_ZONE, PROFILE_READ_ATTEMPTS } from "./constants.ts";
import { dailyActivities } from "./daily.ts";
import { type RefContext, withDecryptedRef } from "./decrypt.ts";
import { invitesActivities } from "./invites.ts";
import { isPortError, sendActivities } from "./send.ts";

const accountId = z.string().min(1).max(64);
const refreshInput = workflowInput.extend({ accountId });
/** A file under the workspace's raw/, as a key relative to its folder. */
const rawKey = z
  .string()
  .max(512)
  .regex(/^raw\/[\w./-]+\.json$/);
const readInput = workflowInput.extend({
  accountId,
  postUrl: z.string().min(1).max(2048),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.int().min(1).max(100),
  rawKey,
});
const profileInput = workflowInput.extend({ accountId, requestKey: rawKey, rawKey });
const notifyInput = workflowInput.extend({
  healthEventId: z.string().min(1).max(64),
  recipient: z.enum(["owner", "operator"]),
});
const { linkedin_account_disconnected, linkedin_not_found, linkedin_provider_error } =
  linkedinPort.errors;
/** What the profile read needs of its activity's context: the entry's, and the attempt. */
type ProfileContext = RefContext & Pick<ActivityContext<TenantClient>, "attempt">;
/** The refresh's: the entry's, and its run's id, which a missing key's line is logged once for. */
type RefreshContext = RefContext & Partial<Pick<ActivityContext<TenantClient>, "workflowId">>;
/** The status call's answer: the status and the member id, or the port's error. */
type StatusAnswer = Pick<AccountStatus, "status" | "memberRef"> | { readonly failed: AppError };
/**
 * A refresh's answer: the status stored; sender_account_in_use when the account was ended for it;
 * `failed`, the code of the check's port error, the status as it was; `held`, no call made while the
 * account's retry_at lies ahead, the status as it was.
 */
export type Refreshed = {
  status: SenderAccountStatus;
  refused?: "sender_account_in_use";
  failed?: ActionOutcome;
  held?: "rate_limited";
};
let log: Logger | undefined;
/** The run whose missing key was logged last: one line per run, not per account. */
let keyMissingRun: string | undefined;

/**
 * The account's status as the provider has it now, stored, with the event when it crossed into
 * `connected` or `disconnected`, and an action-log row (`status_check`): the catch-up for a webhook
 * that never came. An account without a reference (pending, or disconnected by its user) is left as
 * it is; one the provider no longer knows is `disconnected`. The provider's member id for the account
 * goes in as its keyed hash, in the same run (domain/disclosure/member.ts), unless a pairing came
 * during the call (connected_at moved): that id is a previous LinkedIn account's. Without
 * LINKEDIN_HASH_KEY none is stored, and linkedin_hash_key_missing is logged once per run. An account
 * whose LinkedIn account another connected row holds ends `disconnected`, its row logged
 * sender_account_in_use, which the activity answers as a result: no retry. Any other typed port error
 * of the call is answered too (statusCheckFailed); one that is no port error throws. While the
 * account's retry_at lies ahead, no call and no row: `{ status, held: "rate_limited" }`.
 */
export async function refreshStatus(
  context: RefreshContext,
  accountId: string,
): Promise<Refreshed> {
  const row = await context.tenant((tx) =>
    tx.senderAccount.findFirst({
      where: { id: accountId },
      select: { status: true, providerAccountRef: true, connectedAt: true, retryAt: true },
    }),
  );
  if (row === null) throw new AppError(errors.sender_account_not_found);
  if (row.providerAccountRef === null) return { status: row.status };
  if (row.retryAt !== null && row.retryAt > now())
    return { status: row.status, held: "rate_limited" };
  const adapter = await linkedin();
  const answer = await withDecryptedRef(context, accountId, (ref) =>
    adapter.getAccountStatus(ref).then(
      (found): StatusAnswer => ({ status: found.status, memberRef: found.memberRef }),
      (error: unknown): StatusAnswer => {
        const gone = isAppError(error) && error.code === linkedin_not_found;
        if (gone) return { status: "disconnected" as const, memberRef: null };
        if (isPortError(error)) return { failed: error };
        throw error;
      },
    ),
  );
  if ("failed" in answer) return statusCheckFailed(context, accountId, row.status, answer.failed);
  const { status, memberRef } = answer;
  const account = { id: accountId, workspaceId: context.workspaceId };
  const member = memberRef === null ? null : memberOf(memberRef, context.workflowId);
  const refused = await setStatus(context.tenant, account, status, member, row.connectedAt);
  if (refused !== null) return { status: "disconnected", refused };
  const check = { accountId, kind: "status_check", count: 1, outcome: status } as const;
  countAction(await context.tenant(() => logAction(check)));
  return { status };
}

/**
 * A status check's typed port error but linkedin_not_found (C28): its `status_check` row with the
 * error's code, in one run with the reaction a read's error gets: retry_at as the error map sets it (a
 * rate limit's wait, an hour after a provider error), so that the day's check after it is refused its
 * reads, and the account's health (afterPortError: a warning's signal, or the third error). The
 * status stays as stored and is answered with the code, never thrown: Temporal would call a
 * struggling provider again. The next hourly run checks again.
 */
async function statusCheckFailed(
  context: RefreshContext,
  accountId: string,
  status: SenderAccountStatus,
  error: AppError,
): Promise<Refreshed> {
  const failed = outcomeOf(error);
  const row = await context.tenant(async () => {
    const logged = await logAction({ accountId, kind: "status_check", count: 1, outcome: failed });
    await pauseAccount(accountId, effectOf(error).account, retryAfterOf(error));
    await afterPortError(accountId, error, now());
    return logged;
  });
  countAction(row);
  return { status, failed };
}

/** The operator's mail about the trip; without LINKEDIN_ALERT_EMAIL, one warn line with the event's id. */
async function notifyOperator(
  run: ActivityContext<TenantClient>["tenant"],
  workspaceId: string,
  healthEventId: string,
): Promise<HealthMailResult> {
  const result = await mailOperator(run, workspaceId, healthEventId);
  if (!result.sent && result.reason === "no_address") {
    const line = { code: ALERT_EMAIL_MISSING, health_event_id: healthEventId };
    (log ??= createLogger()).warn(
      line,
      "linkedin: no LINKEDIN_ALERT_EMAIL, so the operator is not mailed",
    );
  }
  return result;
}

/** The member id's keyed hash; null without LINKEDIN_HASH_KEY, logged once per run (the workflow's id). */
function memberOf(memberRef: string, runId: string | undefined): string | null {
  const hash = memberHash(memberRef);
  if (hash === null && (runId === undefined || runId !== keyMissingRun)) {
    keyMissingRun = runId;
    const line = { code: errors.linkedin_hash_key_missing };
    (log ??= createLogger()).warn(
      line,
      "linkedin: no LINKEDIN_HASH_KEY, so no member id is stored",
    );
  }
  return hash;
}

/**
 * One page of a post's engagers through the account's own LinkedIn account: the read in the action
 * log, the page written to the files port at `rawKey`, and its key, count and next cursor answered,
 * never the reference. An account not connected, or a post gone or out of its sight, is a refusal;
 * so is a stop, a pause or retry_at ahead since its read was reserved, which makes no call
 * (beforeRead). Each row carries `rawKey` as its call, so the attempts of one page count once.
 */
export async function readPostEngagers(
  context: RefContext,
  input: ReadPostEngagers,
): Promise<EngagersPage | EngagersRefused> {
  const { accountId, postUrl, cursor, limit, rawKey } = input;
  const adapter = await linkedin();
  const log = async (outcome: ActionOutcome, error?: unknown) => {
    const entry = {
      accountId,
      kind: "read_engagers" as const,
      objectRef: postUrl,
      count: 1,
      outcome,
      callRef: rawKey,
    };
    countAction(await context.tenant(() => logRead(entry, error)));
  };
  const read = (providerAccountRef: string) =>
    adapter.listPostEngagers({ providerAccountRef, postUrl, cursor, limit }).then(
      async (page) => {
        await log("ok");
        return page;
      },
      async (error: unknown) => {
        await log(outcomeOf(error), error);
        throw error;
      },
    );
  try {
    const held = await beforeRead(context, accountId);
    if (held !== null) return { refused: held };
    const page = await withDecryptedRef(context, accountId, read);
    const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
    const body = JSON.stringify({ engagers: page.engagers });
    const file = { workspaceId: context.workspaceId, key: rawKey, body };
    const { key } = await files.put({ ...file, contentType: "application/json" });
    return { key, count: page.engagers.length, nextCursor: page.nextCursor };
  } catch (error) {
    const code = isAppError(error) ? error.code : undefined;
    if (code === linkedin_account_disconnected || code === linkedin_not_found)
      return { refused: code };
    throw error;
  }
}

/**
 * One profile through the account's own LinkedIn account, the engager read's twin: its URL read from
 * the request file at `requestKey`, the read in the action log (no object: a profile's URL names a
 * person who may never be one of ours), the profile written at `rawKey`, its key answered. An account
 * not connected, or a profile gone or out of its sight, is a refusal; so is a provider error from
 * attempt PROFILE_READ_ATTEMPTS on, so that the run skips a profile the provider cannot read, and a
 * stop, a pause or retry_at ahead since its read was reserved, which makes no call (beforeRead).
 * Each row carries `rawKey` as its call, so the attempts of one profile count once.
 */
export async function readProfile(
  context: ProfileContext,
  input: ReadProfile,
): Promise<ProfileRead | ProfileRefused> {
  const { accountId, requestKey, rawKey } = input;
  const { workspaceId } = context;
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const request = await files.get({ workspaceId, key: requestKey });
  const { profileUrl } = profileRequestFile.parse(await json(request.body));
  const adapter = await linkedin();
  const log = async (outcome: ActionOutcome, error?: unknown) => {
    const entry = { accountId, kind: "read_profile", count: 1, outcome, callRef: rawKey } as const;
    countAction(await context.tenant(() => logRead(entry, error)));
  };
  const read = (providerAccountRef: string) =>
    adapter.getProfile({ providerAccountRef, profileUrl }).then(
      async (profile) => {
        await log("ok");
        return profile;
      },
      async (error: unknown) => {
        await log(outcomeOf(error), error);
        throw error;
      },
    );
  try {
    const held = await beforeRead(context, accountId);
    if (held !== null) return { refused: held };
    const profile = await withDecryptedRef(context, accountId, read);
    const body = JSON.stringify({ ...profile, fetchedAt: profile.fetchedAt.toISOString() });
    const file = { workspaceId, key: rawKey, body, contentType: "application/json" };
    return { key: (await files.put(file)).key };
  } catch (error) {
    const code = isAppError(error) ? error.code : undefined;
    if (code === linkedin_account_disconnected || code === linkedin_not_found)
      return { refused: code };
    // This profile failed the attempts it gets. A rate limit is the account's, not the profile's.
    if (code === linkedin_provider_error && context.attempt >= PROFILE_READ_ATTEMPTS)
      return { refused: code };
    throw error;
  }
}

/**
 * Just before a read's port call, on every attempt (Temporal retries a read that threw): the switches
 * and the account read again, as its reservation read them, so that a stop, a lost connection, a
 * warning or the third error of an attempt before, or of a send meanwhile, stops the call:
 * readCallRefusal's code, answered with no row, as no call was made; else null.
 */
async function beforeRead(context: RefContext, accountId: string): Promise<ReadCallRefusal | null> {
  return context.tenant(async () => {
    const account = await findAccount(accountId);
    return readCallRefusal(account, await readControls(), now());
  });
}

/** A read's row; after a port error, the account's health in the same run (domain/health/signals.ts). */
async function logRead(entry: Parameters<typeof logAction>[0], error: unknown) {
  const logged = await logAction(entry);
  if (error !== undefined) await afterPortError(entry.accountId, error, now());
  return logged;
}

export const activities = {
  ...dailyActivities,
  ...invitesActivities,
  linkedin_refresh_status: defineActivity<typeof refreshInput, Refreshed, TenantClient>({
    kind: "provider",
    input: refreshInput,
    run: ({ accountId }, context) => refreshStatus(context, accountId),
  }),
  /** Every workspace's id, from tenancy, and nothing else: linkedin_status_refresh's fan-out. */
  linkedin_list_workspaces: defineActivity({
    kind: "db",
    scope: "global",
    input: globalWorkflowInput,
    run: async () => ({ workspaceIds: await listWorkspaceIds() }),
  }),
  /** The workspace's accounts with a reference, oldest first, ids only, read in its own run. */
  linkedin_list_referenced_accounts: defineActivity<
    typeof workflowInput,
    { accountIds: string[] },
    TenantClient
  >({
    kind: "db",
    input: workflowInput,
    run: async (_input, context) => {
      const rows = await context.tenant((tx) =>
        tx.senderAccount.findMany({
          where: { providerAccountRef: { not: null } },
          select: { id: true },
          orderBy: { id: "asc" },
        }),
      );
      return { accountIds: rows.map((row) => row.id) };
    },
  }),
  linkedin_read_post_engagers: defineActivity<
    typeof readInput,
    EngagersPage | EngagersRefused,
    TenantClient
  >({
    kind: "provider",
    input: readInput,
    run: (input, context) => readPostEngagers(context, input),
  }),
  linkedin_read_profile: defineActivity<
    typeof profileInput,
    ProfileRead | ProfileRefused,
    TenantClient
  >({
    kind: "provider",
    input: profileInput,
    run: (input, context) => readProfile(context, input),
  }),
  /** The recipient's mail about one health event, at most once (domain/health/mail.ts). */
  linkedin_mail_health: defineActivity<typeof notifyInput, HealthMailResult, TenantClient>({
    kind: "provider",
    input: notifyInput,
    run: ({ workspaceId, healthEventId, recipient }, context) =>
      recipient === "owner"
        ? mailHealthEvent(context.tenant, workspaceId, healthEventId)
        : notifyOperator(context.tenant, workspaceId, healthEventId),
  }),
  ...sendActivities,
};

export const workflows = defineWorkflows({
  linkedin_daily: { input: globalWorkflowInput, taskQueue: DEFAULT_TASK_QUEUE, scope: "global" },
  linkedin_daily_workspace: { input: workflowInput, taskQueue: DEFAULT_TASK_QUEUE },
  linkedin_notify: { input: notifyInput, taskQueue: DEFAULT_TASK_QUEUE },
  linkedin_refresh_account: { input: refreshInput, taskQueue: DEFAULT_TASK_QUEUE },
  linkedin_status_refresh: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
});

/**
 * Daily at 00:30 UTC, the daily job; hourly, the catch-up for a webhook that never came
 * (docs/runbook.md). Temporal's default overlap policy skips a start while a run is open.
 */
export const schedules = defineSchedules([
  {
    id: "daily",
    workflow: "linkedin_daily",
    spec: { cronExpressions: [DAILY_CRON], timezone: DAILY_ZONE },
    input: {},
  },
  {
    id: "status_refresh",
    workflow: "linkedin_status_refresh",
    spec: { intervals: [{ every: "1 hour" }] },
    input: {},
  },
]);

/** Before the worker polls: the host's logger, for refreshStatus' and the operator's mail's lines. */
export async function onWorkerStart(context: { readonly log: Logger }): Promise<void> {
  log = context.log;
}

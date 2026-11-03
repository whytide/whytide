// The module's workflows, activities and schedule, which the worker host registers
// (core/apps/worker/README.md "Modules"; README.md "Worker"): linkedin_refresh_account, one account's
// status on a Refresh status press (events.ts), and linkedin_status_refresh, global and hourly, every
// account with a reference, workspace by workspace, each through the activity linkedin_refresh_status;
// and the activities linkedin_read_post_engagers and linkedin_read_profile, the engager and profile
// reads a signal run calls by name.
import { json } from "node:stream/consumers";
import type { TenantClient } from "@whytide/db";
import {
  type ActivityContext,
  AppError,
  DEFAULT_TASK_QUEUE,
  defineActivity,
  defineSchedules,
  defineWorkflows,
  globalWorkflowInput,
  isAppError,
  workflowInput,
} from "@whytide/platform";
import { filesConfig, filesPort, getAdapter, linkedinPort } from "@whytide/providers";
import { listWorkspaceIds } from "@whytide/tenancy";
import { z } from "zod";
import type { SenderAccountStatus } from "../domain/accounts.ts";
import { logAction } from "../domain/action-log/log.ts";
import { linkedin } from "../domain/provider.ts";
import { setStatus } from "../domain/status.ts";
import { errors } from "../errors.ts";
import type { EngagersPage, EngagersRefused, ReadPostEngagers } from "../schemas/engagers.ts";
import {
  type ProfileRead,
  type ProfileRefused,
  profileRequestFile,
  type ReadProfile,
} from "../schemas/profile.ts";
import { PROFILE_READ_ATTEMPTS } from "./constants.ts";
import { type RefContext, withDecryptedRef } from "./decrypt.ts";

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
const { linkedin_account_disconnected, linkedin_not_found, linkedin_provider_error } =
  linkedinPort.errors;
/** What the profile read needs of its activity's context: the entry's, and the attempt. */
type ProfileContext = RefContext & Pick<ActivityContext<TenantClient>, "attempt">;

/**
 * The account's status as the provider has it now, stored, with the event when it crossed into
 * `connected` or `disconnected`, and an action-log row (`status_check`): the catch-up for a webhook
 * that never came. An account without a reference (pending, or disconnected by its user) is left as
 * it is; one the provider no longer knows is `disconnected`.
 */
export async function refreshStatus(
  context: RefContext,
  accountId: string,
): Promise<{ status: SenderAccountStatus }> {
  const row = await context.tenant((tx) =>
    tx.senderAccount.findFirst({
      where: { id: accountId },
      select: { status: true, providerAccountRef: true },
    }),
  );
  if (row === null) throw new AppError(errors.sender_account_not_found);
  if (row.providerAccountRef === null) return { status: row.status };
  const adapter = await linkedin();
  const status = await withDecryptedRef(context, accountId, (ref) =>
    adapter.getAccountStatus(ref).then(
      (answer) => answer.status,
      (error: unknown) => {
        const gone = isAppError(error) && error.code === linkedinPort.errors.linkedin_not_found;
        if (gone) return "disconnected" as const;
        throw error;
      },
    ),
  );
  const account = { id: accountId, workspaceId: context.workspaceId };
  await setStatus(context.tenant, account, status);
  const check = { accountId, kind: "status_check", count: 1, outcome: status } as const;
  await context.tenant(() => logAction(check));
  return { status };
}

/**
 * One page of a post's engagers through the account's own LinkedIn account: the read in the action
 * log, the page written to the files port at `rawKey`, and its key, count and next cursor answered,
 * never the reference. An account not connected, or a post gone or out of its sight, is a refusal.
 */
export async function readPostEngagers(
  context: RefContext,
  input: ReadPostEngagers,
): Promise<EngagersPage | EngagersRefused> {
  const { accountId, postUrl, cursor, limit, rawKey } = input;
  const adapter = await linkedin();
  const log = (outcome: string) => {
    const entry = {
      accountId,
      kind: "read_engagers" as const,
      objectRef: postUrl,
      count: 1,
      outcome,
    };
    return context.tenant(() => logAction(entry));
  };
  const read = (providerAccountRef: string) =>
    adapter.listPostEngagers({ providerAccountRef, postUrl, cursor, limit }).then(
      async (page) => {
        await log("ok");
        return page;
      },
      async (error: unknown) => {
        await log(isAppError(error) ? error.code : linkedinPort.errors.linkedin_provider_error);
        throw error;
      },
    );
  try {
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
 * attempt PROFILE_READ_ATTEMPTS on, so that the run skips a profile the provider cannot read.
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
  const log = (outcome: string) =>
    context.tenant(() => logAction({ accountId, kind: "read_profile", count: 1, outcome }));
  const read = (providerAccountRef: string) =>
    adapter.getProfile({ providerAccountRef, profileUrl }).then(
      async (profile) => {
        await log("ok");
        return profile;
      },
      async (error: unknown) => {
        await log(isAppError(error) ? error.code : linkedinPort.errors.linkedin_provider_error);
        throw error;
      },
    );
  try {
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

export const activities = {
  linkedin_refresh_status: defineActivity<
    typeof refreshInput,
    { status: SenderAccountStatus },
    TenantClient
  >({
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
};

export const workflows = defineWorkflows({
  linkedin_refresh_account: { input: refreshInput, taskQueue: DEFAULT_TASK_QUEUE },
  linkedin_status_refresh: {
    input: globalWorkflowInput,
    taskQueue: DEFAULT_TASK_QUEUE,
    scope: "global",
  },
});

/** Hourly: the catch-up for a webhook that never came (docs/runbook.md). */
export const schedules = defineSchedules([
  {
    id: "status_refresh",
    workflow: "linkedin_status_refresh",
    spec: { intervals: [{ every: "1 hour" }] },
    input: {},
  },
]);

// The activity linkedin_check_invites (README.md "Worker"): the day's check of an account's pending
// invitations (domain/invites/check.ts), which linkedin_status_refresh runs after the account's
// refresh, each hour; it is due once a day. The two provider calls are made here, the reference
// opened for each call's time only (decrypt.ts), between the check's tenant runs; a port error is an
// answer to the check, never a throw. It answers counts and codes, never a ref.
import type { TenantClient } from "@whytide/db";
import { type ActivityContext, defineActivity, workflowInput } from "@whytide/platform";
import { z } from "zod";
import { type Called, checkInvites, type InvitesChecked } from "../domain/invites/check.ts";
import { linkedin } from "../domain/provider.ts";
import { ID_MAX_CHARS } from "./constants.ts";
import { type RefContext, withDecryptedRef } from "./decrypt.ts";
import { isPortError } from "./send.ts";

const checkInput = workflowInput.extend({ accountId: z.string().min(1).max(ID_MAX_CHARS) });

/** linkedin_check_invites: the account's check, when due today, at the activity's attempt (1 first). */
export async function checkAccountInvites(
  context: RefContext & Partial<Pick<ActivityContext<TenantClient>, "attempt">>,
  accountId: string,
): Promise<InvitesChecked> {
  const adapter = await linkedin();
  const call = async <T>(fn: (providerAccountRef: string) => Promise<T>): Promise<Called<T>> => {
    try {
      return { ok: await withDecryptedRef(context, accountId, fn) };
    } catch (error) {
      if (!isPortError(error)) throw error;
      return { failed: error };
    }
  };
  const calls = {
    tenant: <T>(fn: () => Promise<T>) => context.tenant(fn),
    listPendingInvites: (cursor: string | undefined) =>
      call((providerAccountRef) =>
        adapter.listPendingInvites(
          cursor === undefined ? { providerAccountRef } : { providerAccountRef, cursor },
        ),
      ),
    getRelation: (memberRef: string) =>
      call((providerAccountRef) => adapter.getRelation({ providerAccountRef, memberRef })),
  };
  return checkInvites(calls, accountId, context.attempt ?? 1);
}

/** The activity, which workflows/index.ts registers. */
export const invitesActivities = {
  linkedin_check_invites: defineActivity<typeof checkInput, InvitesChecked, TenantClient>({
    kind: "provider",
    input: checkInput,
    run: ({ accountId }, context) => checkAccountInvites(context, accountId),
  }),
};

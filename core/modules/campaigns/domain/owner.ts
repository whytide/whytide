// A sender's owner (gamma-p6-040; README.md "The queue", "The gate", "A removed member"), read in
// the caller's tenant run with no cache: a LinkedIn account's owner as linkedin holds it, and whether
// a user is an active member of the run's workspace (tenancy's findActiveMembership, which another
// workspace's membership, or a removed one, never answers).
import { findSenderAccount, errors as linkedinErrors } from "@whytide/linkedin";
import { isAppError } from "@whytide/platform";
import { findActiveMembership } from "@whytide/tenancy";

/** The account's owner; null for an account linkedin no longer holds in the run's workspace. */
export async function accountOwnerOf(senderAccountId: string): Promise<string | null> {
  try {
    return (await findSenderAccount(senderAccountId)).ownerUserId;
  } catch (error) {
    if (isAppError(error) && error.code === linkedinErrors.sender_account_not_found) return null;
    throw error;
  }
}

/** Whether the user is an active member of the run's workspace. */
export async function isActiveMember(userId: string): Promise<boolean> {
  return (await findActiveMembership(userId)) !== null;
}

// The risk disclosure for sending (docs/concepts.md "Risk disclosure"; docs/flows.md "Accepting the
// disclosure"): an account sends once its owner has accepted DISCLOSURE_VERSION and confirmed the
// LinkedIn account is their own personal one. Alpha's accounts, version 1, keep reading. The connect
// stores both (domain/accounts.ts); an account connected before, or replaced since, gets them through
// acceptDisclosure, in the request's tenant run.
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";
import { errors } from "../../errors.ts";
import { findAccount, type SenderAccount } from "../accounts.ts";
import { now } from "../clock.ts";
import { DISCLOSURE_VERSION } from "./constants.ts";

type Disclosed = Pick<SenderAccount, "disclosureVersion" | "personalAccountConfirmedAt">;

/** The account sends only once its owner accepts: a version below the current one, or no confirmation. */
export const sendingDisclosureRequired = (account: Disclosed): boolean =>
  account.disclosureVersion < DISCLOSURE_VERSION || account.personalAccountConfirmedAt === null;

/**
 * The owner's acceptance of the sending disclosure: by the account's owner only (not_account_owner),
 * of DISCLOSURE_VERSION (disclosure_version_invalid), with the personal-account confirmation
 * (personal_account_required); a refusal stores nothing. While the disclosure is required, the
 * version, the acknowledgement's time and the confirmation's are stored; after, nothing changes, so a
 * repeat answers the same account. The account as it stands.
 */
export async function acceptDisclosure(
  accountId: string,
  userId: string,
  input: { readonly version: number; readonly personalAccount: boolean },
): Promise<SenderAccount> {
  const account = await findAccount(accountId);
  if (account.ownerUserId !== userId) throw new AppError(errors.not_account_owner);
  if (input.version !== DISCLOSURE_VERSION) throw new AppError(errors.disclosure_version_invalid);
  if (input.personalAccount !== true) throw new AppError(errors.personal_account_required);
  if (!sendingDisclosureRequired(account)) return account;
  const at = now();
  await tenantClient.senderAccount.update({
    where: { id: account.id },
    data: {
      disclosureVersion: DISCLOSURE_VERSION,
      disclosureAcknowledgedAt: at,
      personalAccountConfirmedAt: at,
    },
  });
  return findAccount(account.id);
}

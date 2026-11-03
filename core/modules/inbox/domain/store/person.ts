// The person a store writes for (README.md "The store", "The platform's own messages"), in the
// caller's tenant run: contacts still knows them, and, for the account's own messages, their lead
// locked first, as every writer of a person's rows takes it.
import { errors as contactsErrors, getPerson, lockLeadStatus } from "@whytide/contacts";
import { isAppError } from "@whytide/platform";

/** Whether contacts still knows the person: false once they are erased (person_not_found). */
export async function known(personId: string): Promise<boolean> {
  try {
    await getPerson(personId);
    return true;
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) return false;
    throw error;
  }
}

/**
 * The person's lead locked until the run ends, then whether contacts still knows them. privacy's
 * erasure locks the lead before it deletes any of their rows, inbox's and the person last, so a
 * store that waits on it then finds the person gone and writes nothing back; once this run holds the
 * lead, the person stays until it commits.
 */
export async function lockKnown(personId: string): Promise<boolean> {
  await lockLeadStatus(personId);
  return known(personId);
}

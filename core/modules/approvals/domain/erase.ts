// erasePerson (README.md "Public interface"; core/modules/privacy/README.md "Erasers"): approvals'
// step of the deletion script, in the caller's tenant run. An item holds ids only, so the person's
// items are deleted; the decisions their steps carry stay campaigns'.
import { errors as contactsErrors } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";

/**
 * Deletes the person's items, whether contacts still has the person or not; person_not_found for
 * an id that names nobody. The rows deleted, by table.
 */
export async function erasePerson(personId: string): Promise<{ approval_items: number }> {
  // Prisma drops an undefined value from a where: unchecked, that would be every item.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const { count } = await tenantClient.approvalItem.deleteMany({ where: { personId } });
  return { approval_items: count };
}

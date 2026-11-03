// inbox's step of the deletion script (core/modules/privacy/README.md "Erasers"), in the caller's
// tenant run through its tenantClient: the person's messages and every message of their threads, then
// their threads, which the messages' foreign key holds until then.
import { errors as contactsErrors } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError } from "@whytide/platform";

/** Deletes the person's messages, then their threads; person_not_found for no id. The rows deleted. */
export async function erasePerson(
  personId: string,
): Promise<{ messages: number; threads: number }> {
  // Prisma drops an undefined value from a where: unchecked, that would be every row.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  const threads = await tenantClient.thread.findMany({ where: { personId }, select: { id: true } });
  const threadId = { in: threads.map(({ id }) => id) };
  const messages = await tenantClient.message.deleteMany({
    where: { OR: [{ personId }, { threadId }] },
  });
  const deleted = await tenantClient.thread.deleteMany({ where: { personId } });
  return { messages: messages.count, threads: deleted.count };
}

// campaigns' step of the deletion script (privacy's README "Erasers"): enrollments and their steps go
// with the person (data model §6.1). In the caller's tenant run, through its tenantClient. The rows
// are locked first in the order every stop takes, the lead, then the enrollments, then the steps
// (beta-p4-040), so an erasure meeting a hold, a skip, the sender's settle or the acceptance
// subscriber waits for it rather than deadlocks; privacy's run holds the lead already.
import { errors as contactsErrors, lockLeadStatus } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { AppError, currentTenant } from "@whytide/platform";

/**
 * Deletes the person's step executions, then their enrollments, which the steps' foreign key holds
 * until then, once the lead and the enrollments are locked; person_not_found for no id. The rows
 * deleted, by table.
 */
export async function erasePerson(
  personId: string,
): Promise<{ step_executions: number; enrollments: number }> {
  // Prisma drops an undefined value from a where: unchecked, that would be every row.
  if (typeof personId !== "string" || personId.trim() === "") {
    throw new AppError(contactsErrors.person_not_found);
  }
  await lockLeadStatus(personId);
  const { workspaceId } = currentTenant();
  await tenantClient.$queryRaw`
    SELECT id FROM enrollments WHERE workspace_id = ${workspaceId} AND person_id = ${personId}
    ORDER BY id FOR UPDATE`;
  const steps = await tenantClient.stepExecution.deleteMany({ where: { personId } });
  const enrollments = await tenantClient.enrollment.deleteMany({ where: { personId } });
  return { step_executions: steps.count, enrollments: enrollments.count };
}

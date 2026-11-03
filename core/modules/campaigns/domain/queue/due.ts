// The steps a queue run opens items for (README.md "The queue"; docs/flows.md "The queue"), in the
// workspace's tenant run: the `planned` connection requests and messages due by now plus approvals'
// QUEUE_WINDOW_HOURS, whose enrollment is active, oldest first. A withdrawal has no item, and a
// message with no due time yet, before its anchor, waits. Each step is checked again as it is opened
// (open.ts).
import { QUEUE_WINDOW_HOURS } from "@whytide/approvals";
import { tenantClient } from "@whytide/db";
import { MS_PER_HOUR } from "../constants.ts";
import { requireInstant } from "../gate/instant.ts";
import { APPROVED_ACTIONS } from "../steps/constants.ts";

/** The ids of the steps due by `at` plus the window whose enrollment is active, oldest first. */
export async function dueStepIds(at: Date): Promise<string[]> {
  const now = requireInstant(at, "at");
  const until = new Date(now.getTime() + QUEUE_WINDOW_HOURS * MS_PER_HOUR);
  const due = await tenantClient.stepExecution.findMany({
    where: { status: "planned", actionType: { in: [...APPROVED_ACTIONS] }, dueAt: { lte: until } },
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    select: { id: true, enrollmentId: true },
  });
  if (due.length === 0) return [];
  // The enrollments in a query of their own: the tenant client refuses a relation in a query.
  const enrollmentIds = [...new Set(due.map(({ enrollmentId }) => enrollmentId))];
  const active = await tenantClient.enrollment.findMany({
    where: { id: { in: enrollmentIds }, status: "active" },
    select: { id: true },
  });
  const activeIds = new Set(active.map(({ id }) => id));
  return due.flatMap(({ id, enrollmentId }) => (activeIds.has(enrollmentId) ? [id] : []));
}

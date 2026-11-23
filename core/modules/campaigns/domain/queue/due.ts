// The steps a queue run opens items for (README.md "The queue"; docs/flows.md "The queue"), in the
// workspace's tenant run: the `planned` connection requests and messages due by now plus approvals'
// queueWindowHours (APPROVALS_QUEUE_WINDOW_HOURS), whose enrollment is active and whose campaign is
// active (a paused enrollment's, or a paused or draft campaign's, waits: ../pause/), oldest first.
// A withdrawal has no item, and a message with no due time yet, before its anchor, waits. Each step
// is checked again as it is opened (open.ts).
import { queueWindowHours } from "@whytide/approvals";
import { tenantClient } from "@whytide/db";
import { MS_PER_HOUR } from "../constants.ts";
import { requireInstant } from "../gate/instant.ts";
import { pausesOf } from "../pause/status.ts";
import { APPROVED_ACTIONS } from "../steps/constants.ts";

/** The ids of the steps due by `at` plus the window whose enrollment goes on, oldest first. */
export async function dueStepIds(at: Date): Promise<string[]> {
  const now = requireInstant(at, "at");
  const until = new Date(now.getTime() + queueWindowHours * MS_PER_HOUR);
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
  const waiting = await pausesOf(active.map(({ id }) => id));
  const activeIds = new Set(active.flatMap(({ id }) => (waiting.has(id) ? [] : [id])));
  return due.flatMap(({ id, enrollmentId }) => (activeIds.has(enrollmentId) ? [id] : []));
}

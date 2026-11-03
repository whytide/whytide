// The modules' schedules (README "Schedules"): upserted at every start under `<module>.<id>`, so a
// second start updates the one schedule and never adds another. Their state follows
// WORKER_SCHEDULES at each start: `off` keeps them paused, `on` resumes them. A schedule gone from
// the code stays in Temporal until someone deletes it.
import {
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleOptionsStartWorkflowAction,
  type ScheduleSpec,
  type Workflow,
} from "@temporalio/client";
import type { HostSchedule } from "./modules.ts";

export async function upsertSchedules(
  client: Client,
  schedules: readonly HostSchedule[],
  options: { readonly taskQueue: string; readonly paused: boolean },
): Promise<void> {
  for (const schedule of schedules) {
    const spec = schedule.spec as ScheduleSpec;
    const action: ScheduleOptionsStartWorkflowAction<Workflow> = {
      type: "startWorkflow",
      workflowType: schedule.workflow,
      args: [schedule.input],
      taskQueue: options.taskQueue,
      workflowId: schedule.id,
    };
    const state = { paused: options.paused };
    try {
      await client.schedule.create({ scheduleId: schedule.id, spec, action, state });
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) throw error;
      const handle = client.schedule.getHandle(schedule.id);
      await handle.update((previous) => ({ spec, action, state, policies: previous.policies }));
    }
  }
}

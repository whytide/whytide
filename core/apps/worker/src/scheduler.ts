// The worker's scheduler of a row's own schedule (README "Schedules"; platform README "Workflows"),
// bound at start beside the starter: a module's subscriber creates, pauses and deletes it (signals'
// `signals-<sourceId>`). Each instant is a calendar in UTC that matches it alone, to the second; the
// action starts the workflow on the host's task queue under the schedule's id, to which Temporal
// appends the time. The input is parsed as the starter parses it.
import {
  type CalendarSpec,
  type Client,
  ScheduleAlreadyRunning,
  type ScheduleHandle,
  ScheduleNotFoundError,
} from "@temporalio/client";
import type { WorkflowRegistration, WorkflowScheduler } from "@whytide/platform";
import { parseWorkflowInput } from "./starter.ts";

const MONTHS = [
  "JANUARY",
  "FEBRUARY",
  "MARCH",
  "APRIL",
  "MAY",
  "JUNE",
  "JULY",
  "AUGUST",
  "SEPTEMBER",
  "OCTOBER",
  "NOVEMBER",
  "DECEMBER",
] as const;

/** The calendar of one instant: every field set, so it matches that second only. */
export function calendarOf(at: Date): CalendarSpec {
  return {
    year: at.getUTCFullYear(),
    month: MONTHS[at.getUTCMonth()],
    dayOfMonth: at.getUTCDate(),
    hour: at.getUTCHours(),
    minute: at.getUTCMinutes(),
    second: at.getUTCSeconds(),
  };
}

export function workflowScheduler(
  temporal: Pick<Client, "schedule">,
  workflows: ReadonlyMap<string, WorkflowRegistration>,
  taskQueue: string,
): WorkflowScheduler {
  const change = async (scheduleId: string, fn: (handle: ScheduleHandle) => Promise<void>) => {
    try {
      await fn(temporal.schedule.getHandle(scheduleId));
      return { found: true };
    } catch (error) {
      if (error instanceof ScheduleNotFoundError) return { found: false };
      throw error;
    }
  };
  return {
    async create({ scheduleId, workflow, input, at, startNow = false, paused = false }) {
      const args = [parseWorkflowInput(workflows, workflow, input)];
      try {
        await temporal.schedule.create({
          scheduleId,
          spec: { calendars: at.map(calendarOf), timezone: "UTC" },
          action: {
            type: "startWorkflow",
            workflowType: workflow,
            args,
            taskQueue,
            workflowId: scheduleId,
          },
          state: { paused, triggerImmediately: startNow && !paused },
        });
        return { created: true };
      } catch (error) {
        if (error instanceof ScheduleAlreadyRunning) return { created: false };
        throw error;
      }
    },
    setPaused: (scheduleId, paused) =>
      change(scheduleId, (handle) => (paused ? handle.pause() : handle.unpause())),
    delete: (scheduleId) => change(scheduleId, (handle) => handle.delete()),
  };
}

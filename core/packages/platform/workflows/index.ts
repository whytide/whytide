// Workflows, activities and schedules as a module declares them (README "Workflows";
// core/apps/worker/docs/workflows.md; architecture §8, coding §4). A module's workflows/index.ts
// exports `workflows`, `activities` and `schedules`; the worker host registers them from its
// generated list. Inputs carry ids only: each extends workflowInput, or globalWorkflowInput for one
// declared `scope: "global"`, and the lint rule workflow-input-ids-only refuses a field of the PII
// registry or a `/// pii` column. Nothing here imports Temporal: the workflow functions sit in the
// module's workflows/workflows.ts, and startWorkflow, a subscriber's start of one on demand, goes to
// the starter the worker host binds, cancelWorkflow to its canceller, as createSchedule and the
// others of a row's schedule go to its scheduler.
import { z } from "zod";
import { AppError, defineErrors } from "../errors/index.ts";

/** The base of every workflow and activity input: the workspace it works for. Ids only. */
export const workflowInput = z.object({ workspaceId: z.string().min(1) });
/** The base of a global one's (`scope: "global"`): no workspace, for work that spans them. Ids only. */
export const globalWorkflowInput = z.object({});

/** Alpha's one task queue. A registration names its queue, so a later split is a declaration. */
export const DEFAULT_TASK_QUEUE = "whytide";

/** A workflow's registration: the key is the name its function is exported under, `<module>_…`. */
export type WorkflowRegistration = {
  readonly input: z.ZodObject;
  readonly taskQueue: string;
  /** `global`: for no workspace, its input extends globalWorkflowInput. */
  readonly scope?: "global";
};

/** The retry policy of an activity: `provider` 5 attempts with backoff, `ai` 3, `db` 3. */
export type ActivityKind = "provider" | "ai" | "db";

/** What an activity gets besides its input. `Tx` is db's TenantClient. */
export type ActivityContext<Tx = unknown> = {
  readonly workspaceId: string;
  /** The id of the workflow execution that runs it; a schedule's run has one Temporal made. */
  readonly workflowId: string;
  /** 1 on the first attempt. */
  readonly attempt: number;
  /** One tenant run for the input's workspace, as service:worker: one per database step, never around callAgent or a provider call. */
  tenant<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
};

/**
 * A global activity's context: no workspace and no tenant run. It reaches the global tables in
 * withoutTenant(reason) with db's globalClient, or starts one workflow per workspace.
 */
export type GlobalActivityContext = { readonly attempt: number };

export type ActivityDefinition<I extends z.ZodObject = z.ZodObject, O = unknown, Tx = unknown> = {
  readonly kind: ActivityKind;
  /** Extends workflowInput, or globalWorkflowInput with `scope: "global"`. */
  readonly input: I;
} & (
  | {
      readonly scope?: undefined;
      run(input: z.output<I>, context: ActivityContext<Tx>): Promise<O>;
    }
  | {
      readonly scope: "global";
      run(input: z.output<I>, context: GlobalActivityContext): Promise<O>;
    }
);

/** The subset of Temporal's ScheduleSpec a module uses; durations as `"1 day"` or milliseconds. */
export type ScheduleSpec = {
  readonly intervals?: readonly {
    readonly every: string | number;
    readonly offset?: string | number;
  }[];
  readonly cronExpressions?: readonly string[];
  readonly timezone?: string;
};
export type ScheduleDefinition = {
  /** Unique in its module; the schedule's id in Temporal is `<module>.<id>`. */
  readonly id: string;
  /** A workflow the module registers, global or not; `input` is parsed against its schema at start. */
  readonly workflow: string;
  readonly spec: ScheduleSpec;
  readonly input: Readonly<Record<string, unknown>>;
};

/** The activities as a workflow calls them: `proxyActivities<ActivityFunctions<typeof activities>>(…)`. */
export type ActivityFunctions<T extends Record<string, ActivityDefinition<z.ZodObject, unknown>>> =
  {
    readonly [K in keyof T]: (input: z.input<T[K]["input"]>) => ReturnType<T[K]["run"]>;
  };

export const defineWorkflows = <const T extends Record<string, WorkflowRegistration>>(map: T): T =>
  map;
/** Types `run` from `input`; `Tx` stays out of the result, so the module's exports name no Prisma type. */
export const defineActivity = <I extends z.ZodObject, O, Tx = unknown>(
  definition: ActivityDefinition<I, O, Tx>,
): ActivityDefinition<I, O> => definition;
export const defineSchedules = (
  schedules: readonly ScheduleDefinition[],
): readonly ScheduleDefinition[] => schedules;

/** A start on demand: a registered workflow, its input and an id derived from ids only. */
export type WorkflowStart = {
  readonly workflow: string;
  /** Parsed against the workflow's registered input by the starter. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Deterministic, `<module>.<purpose>:<workspaceId>:<id>`: a second start of it is no new run. */
  readonly workflowId: string;
  /**
   * One run of the id at a time instead of one ever: a start while it runs makes none, a start
   * after it closed makes a new run (qualification's batch, `<module>.<purpose>:<workspaceId>:current`).
   */
  readonly oneAtATime?: boolean;
};
/** `false` when a run of that id is running or, without `oneAtATime`, has run: this start made none. */
export type WorkflowStarted = { readonly started: boolean };
/** The worker host's (core/apps/worker/src/starter.ts). */
export type WorkflowStarter = { start(request: WorkflowStart): Promise<WorkflowStarted> };

/** A start where no starter is bound, in the api or before the worker's start: a bug, so 500. */
export const workflowErrors = defineErrors({ workflows_not_bound: { status: 500 } });
let starter: WorkflowStarter | undefined;

/** At the worker's start; the function returned, at its close, puts back the one bound before. */
export function bindWorkflowStarter(next: WorkflowStarter): () => void {
  const previous = starter;
  starter = next;
  return () => {
    if (starter === next) starter = previous;
  };
}

/** For a subscriber in the worker (README "Workflows"); `workflows_not_bound` anywhere else. */
export async function startWorkflow(request: WorkflowStart): Promise<WorkflowStarted> {
  if (!starter) throw new AppError(workflowErrors.workflows_not_bound);
  return starter.start(request);
}

/** A cancel on demand: the id of an open workflow, a start's or a schedule's run's. */
export type WorkflowCancel = { readonly workflowId: string };
/** `false` when no open workflow has that id, none ever or it closed: this cancel asked nothing. */
export type WorkflowCancelled = { readonly cancelled: boolean };
/** The worker host's (core/apps/worker/src/canceller.ts). */
export type WorkflowCanceller = { cancel(request: WorkflowCancel): Promise<WorkflowCancelled> };
let canceller: WorkflowCanceller | undefined;

/** At the worker's start, beside the starter; the function returned puts back the one before. */
export function bindWorkflowCanceller(next: WorkflowCanceller): () => void {
  const previous = canceller;
  canceller = next;
  return () => {
    if (canceller === next) canceller = previous;
  };
}

/** For a subscriber in the worker, as startWorkflow: `workflows_not_bound` anywhere else. */
export async function cancelWorkflow(request: WorkflowCancel): Promise<WorkflowCancelled> {
  if (!canceller) throw new AppError(workflowErrors.workflows_not_bound);
  return canceller.cancel(request);
}

/** A row's own schedule (README "Workflows"): its workflow at each instant, to the second, in UTC. */
export type WorkflowSchedule = {
  /** `<module>-<row id>`, unique in the namespace. */
  readonly scheduleId: string;
  readonly workflow: string;
  /** Parsed against the workflow's registered input by the scheduler. Ids only. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly at: readonly Date[];
  /** One run now as well: an instant has passed already. Not while paused. */
  readonly startNow?: boolean;
  readonly paused?: boolean;
};
/** The worker host's (core/apps/worker/src/scheduler.ts). `false`: it existed already, or is gone. */
export type WorkflowScheduler = {
  create(schedule: WorkflowSchedule): Promise<{ readonly created: boolean }>;
  setPaused(scheduleId: string, paused: boolean): Promise<{ readonly found: boolean }>;
  delete(scheduleId: string): Promise<{ readonly found: boolean }>;
};
let scheduler: WorkflowScheduler | undefined;

/** At the worker's start, beside the starter; the function returned puts back the one before. */
export function bindWorkflowScheduler(next: WorkflowScheduler): () => void {
  const previous = scheduler;
  scheduler = next;
  return () => {
    if (scheduler === next) scheduler = previous;
  };
}

function boundScheduler(): WorkflowScheduler {
  if (!scheduler) throw new AppError(workflowErrors.workflows_not_bound);
  return scheduler;
}

/** For a subscriber in the worker, as startWorkflow: `workflows_not_bound` anywhere else. */
export const createSchedule = async (schedule: WorkflowSchedule) =>
  boundScheduler().create(schedule);
export const pauseSchedule = async (scheduleId: string, paused: boolean) =>
  boundScheduler().setPaused(scheduleId, paused);
export const deleteSchedule = async (scheduleId: string) => boundScheduler().delete(scheduleId);

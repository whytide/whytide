// The modules (README "Modules"): every core/modules/<name>, loaded at start from the list
// `pnpm -F worker modules:generate` writes, never one kept by hand. Its events.ts declares its
// events and subscribes to others', for the outbox loop; its workflows/index.ts exports `workflows`,
// `activities` and `schedules`. Both load from the module's build, dist/, as in the api host, where
// `@whytide/<name>` resolves as well: one copy of each module per process. A missing build stops the
// start with worker_module_not_built. A name starts with its module's (`<module>_…`), an input has
// `workspaceId`, or none with `scope: "global"`, a schedule names a workflow of its module and an
// input its schema reads; anything else stops the start. The declarations only: which activities a
// workflow calls is its code's. An `onWorkerStart` export of workflows/index.ts is awaited before
// the worker polls (credits binds its client there). An `alerts` export names the module's own events
// that alert the team channel (README "Alerts"): each one registered and the module's, else the start
// stops.
import { relative, resolve } from "node:path";
import {
  type ActivityDefinition,
  AppError,
  DEFAULT_TASK_QUEUE,
  type Logger,
  registeredEvents,
  type ScheduleDefinition,
  type WorkflowRegistration,
} from "@whytide/platform";
import { z } from "zod";
import { workerErrors } from "./errors.ts";

export type ModuleLoader = {
  readonly name: string;
  readonly events?: () => Promise<unknown>;
  readonly workflows?: () => Promise<unknown>;
};
/** A schedule as Temporal holds it: `id` is `<module>.<id>`. */
export type HostSchedule = Omit<ScheduleDefinition, "id"> & { readonly id: string };
/** A module's start hook in the worker, given the host's logger. */
export type WorkerStartHook = (context: { readonly log: Logger }) => Promise<void>;
export type HostModules = {
  readonly workflows: ReadonlyMap<string, WorkflowRegistration>;
  readonly activities: ReadonlyMap<string, ActivityDefinition>;
  readonly schedules: readonly HostSchedule[];
  readonly starts: readonly { readonly name: string; readonly onWorkerStart: WorkerStartHook }[];
  /** The events the modules' `alerts` name, each its module's own. */
  readonly alerts: readonly string[];
};

const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const KINDS = new Set(["provider", "ai", "db"]);
/** The worker's own workflow (src/smoke-workflow.ts). */
const SMOKE: WorkflowRegistration = { input: z.object({}), taskQueue: DEFAULT_TASK_QUEUE };

/** A schedule's id in Temporal, the same at every start, so that the upsert finds it. */
export const scheduleId = (module: string, id: string): string => `${module}.${id}`;

/** An input for its scope: a workspace's declares `workspaceId`, a global one's does not. */
const isInput = (value: unknown, scope: unknown): value is z.ZodObject =>
  value instanceof z.ZodObject &&
  (scope === undefined || scope === "global") &&
  "workspaceId" in value.shape === (scope === undefined);

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
/** The build file an import missed, from the repository: a module, or one it imports, not built. */
function missingBuild(error: unknown): string | undefined {
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code !== "ERR_MODULE_NOT_FOUND") return undefined;
  const path = /Cannot find module '([^']+)'/.exec((error as Error).message)?.[1];
  return path && /[\\/]dist[\\/]/.test(path) ? relative(repo, path) : undefined;
}

export async function loadModules(loaders: readonly ModuleLoader[]): Promise<HostModules> {
  const workflows = new Map([["worker_smoke", SMOKE]]);
  const activities = new Map<string, ActivityDefinition>();
  const schedules: HostSchedule[] = [];
  const starts: { name: string; onWorkerStart: WorkerStartHook }[] = [];
  const alerts: string[] = [];
  const owners = new Map([["worker_smoke", "worker"]]);
  for (const { name, events, workflows: load } of loaders) {
    const invalid = (field: string, cause?: unknown) =>
      new AppError(workerErrors.worker_module_invalid, { details: { module: name, field }, cause });
    const [, declared = {}] = await Promise.all([events?.(), load?.()]).catch((error: unknown) => {
      const missing = missingBuild(error);
      if (!missing) throw invalid("import", error);
      const details = { module: name, missing };
      throw new AppError(workerErrors.worker_module_not_built, { details, cause: error });
    });
    const entries = (field: "workflows" | "activities") => {
      const value = (declared as Record<string, unknown>)[field] ?? {};
      if (typeof value !== "object" || value === null) throw invalid(field);
      const list = Object.entries(value as Record<string, unknown>);
      for (const [key] of list) {
        if (!NAME.test(key) || !key.startsWith(`${name}_`)) throw invalid(`${field}.${key}`);
        const first = owners.get(key);
        if (first) {
          const details = { field, sources: [first, name] };
          throw new AppError(workerErrors.worker_duplicate_registration, { details });
        }
        owners.set(key, name);
      }
      return list;
    };
    for (const [key, value] of entries("workflows")) {
      const { input, taskQueue, scope } = (value ?? {}) as WorkflowRegistration;
      if (!isInput(input, scope) || taskQueue !== DEFAULT_TASK_QUEUE)
        throw invalid(`workflows.${key}`);
      workflows.set(key, value as WorkflowRegistration);
    }
    for (const [key, value] of entries("activities")) {
      const { kind, input, run, scope } = (value ?? {}) as ActivityDefinition;
      if (!KINDS.has(kind) || !isInput(input, scope) || typeof run !== "function")
        throw invalid(`activities.${key}`);
      activities.set(key, value as ActivityDefinition);
    }
    const own = (declared as Record<string, unknown>).schedules ?? [];
    if (!Array.isArray(own)) throw invalid("schedules");
    for (const schedule of own as ScheduleDefinition[]) {
      const id = scheduleId(name, String(schedule.id));
      const mine = owners.get(schedule.workflow) === name;
      const input = mine ? workflows.get(schedule.workflow)?.input : undefined;
      const taken = schedules.some((other) => other.id === id);
      if (!NAME.test(String(schedule.id)) || taken || !input?.safeParse(schedule.input).success)
        throw invalid(`schedules.${String(schedule.id)}`);
      schedules.push({ ...schedule, id });
    }
    const ownAlerts = (declared as Record<string, unknown>).alerts ?? [];
    if (!Array.isArray(ownAlerts)) throw invalid("alerts");
    for (const event of ownAlerts as unknown[]) {
      const own = typeof event === "string" && event.startsWith(`${name}.`);
      if (!own || !registeredEvents().has(event as string)) {
        const details = { module: name, field: "alerts", event: String(event) };
        throw new AppError(workerErrors.worker_module_invalid, { details });
      }
      alerts.push(event);
    }
    const { onWorkerStart } = declared as Record<string, unknown>;
    if (onWorkerStart !== undefined) {
      if (typeof onWorkerStart !== "function") throw invalid("onWorkerStart");
      starts.push({ name, onWorkerStart: onWorkerStart as WorkerStartHook });
    }
  }
  return { workflows, activities, schedules, starts, alerts };
}

/** Each module's onWorkerStart, in the modules' order; a throw is worker_module_invalid. */
export async function startModules(modules: HostModules, log: Logger): Promise<void> {
  for (const { name, onWorkerStart } of modules.starts) {
    try {
      await onWorkerStart({ log });
    } catch (cause) {
      const details = { module: name, field: "onWorkerStart" };
      throw new AppError(workerErrors.worker_module_invalid, { details, cause });
    }
  }
}

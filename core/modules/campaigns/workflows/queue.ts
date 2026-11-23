// The queue's tick (README.md "The queue"): every TICK_MINUTES, one campaigns_queue per workspace of
// tenancy's list, by an id that names the tick's slot, one run of it at a time, so the tick's
// activity tried again in its slot starts no second run while the first is open. Two slots' runs may
// overlap: each step's move is conditioned on its status, and openItem answers a step's open item.
// A run's pages (gamma-p0-085): QUEUE_PAGE_SIZE due steps at most, after its cursor in id order,
// or, under APP_ENV=test only, the size a worker test sets through useQueuePageSize, so that a test
// continues a run as new over a few steps; any other environment refuses it.
import { platformConfig, startWorkflow, type WorkflowStart } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { MS_PER_MINUTE, QUEUE_PAGE_SIZE, TICK_MINUTES } from "./constants.ts";

let pageSize = QUEUE_PAGE_SIZE;

/** The start of the slot of `at`, its TICK_MINUTES in UTC, as `20261029T1015Z`. */
export function queueSlot(at: Date): string {
  const size = TICK_MINUTES * MS_PER_MINUTE;
  const start = new Date(Math.floor(at.getTime() / size) * size);
  const two = (value: number) => String(value).padStart(2, "0");
  const day = `${start.getUTCFullYear()}${two(start.getUTCMonth() + 1)}${two(start.getUTCDate())}`;
  return `${day}T${two(start.getUTCHours())}${two(start.getUTCMinutes())}Z`;
}

/** The workspace's queue run for the slot: `campaigns.queue:<workspaceId>:<slot>`. */
export function queueStart(workspaceId: string, slot: string): WorkflowStart {
  return {
    workflow: "campaigns_queue",
    input: { workspaceId },
    workflowId: `campaigns.queue:${workspaceId}:${slot}`,
    oneAtATime: true,
  };
}

/**
 * Tenancy's workspaces, each one's queue run started for the slot of `at`. One that fails leaves the
 * others started, and the tick then fails with its code.
 */
export async function startQueueRuns(at: Date): Promise<{ workspaces: number; started: number }> {
  const slot = queueSlot(at);
  // Tenancy's list: no module reads another's tables (decisions.md, 2026-10-22).
  const workspaceIds = await listWorkspaceIds();
  const failures: unknown[] = [];
  let started = 0;
  for (const workspaceId of workspaceIds) {
    try {
      if ((await startWorkflow(queueStart(workspaceId, slot))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

/** For the worker's tests: the due steps a page holds; undefined puts QUEUE_PAGE_SIZE back. */
export function useQueuePageSize(size: number | undefined): void {
  if (platformConfig.APP_ENV !== "test") {
    throw new Error("useQueuePageSize: only under APP_ENV=test");
  }
  pageSize = size ?? QUEUE_PAGE_SIZE;
}

/**
 * The page of the due steps after the cursor `afterId`, in id order, and the next page's cursor:
 * the page's last id while steps remain after it, else null.
 */
export function duePage(
  stepIds: readonly string[],
  afterId: string | undefined,
): { stepIds: string[]; next: string | null } {
  const after = [...stepIds].sort().filter((id) => afterId === undefined || id > afterId);
  const page = after.slice(0, pageSize);
  return { stepIds: page, next: after.length > page.length ? (page.at(-1) ?? null) : null };
}

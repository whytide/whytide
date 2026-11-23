// The sweep's pages (gamma-p0-085; README.md "The workflow"), as linkedin's status refresh pages:
// messaging_list_workspaces answers the workspaces after the run's cursor, in id order,
// SWEEP_PAGE_SIZE at most, or, under APP_ENV=test only, the size a worker test sets through
// useSweepPageSize, so that a test continues a run as new over a few workspaces; any other
// environment refuses it.
import { platformConfig } from "@whytide/platform";
import { SWEEP_PAGE_SIZE } from "./constants.ts";

let pageSize = SWEEP_PAGE_SIZE;

/** For the worker's tests: the workspaces a page holds; undefined puts SWEEP_PAGE_SIZE back. */
export function useSweepPageSize(size: number | undefined): void {
  if (platformConfig.APP_ENV !== "test")
    throw new Error("useSweepPageSize: only under APP_ENV=test");
  pageSize = size ?? SWEEP_PAGE_SIZE;
}

/**
 * The page of the workspaces after the cursor `afterId`, in id order, and the next page's cursor:
 * the page's last id while workspaces remain after it, else null.
 */
export function workspacePage(
  workspaceIds: readonly string[],
  afterId: string | undefined,
): { workspaceIds: string[]; next: string | null } {
  const after = [...workspaceIds].sort().filter((id) => afterId === undefined || id > afterId);
  const page = after.slice(0, pageSize);
  return { workspaceIds: page, next: after.length > page.length ? (page.at(-1) ?? null) : null };
}

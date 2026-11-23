// linkedin_status_refresh's pages (gamma-p0-085; README.md "Worker"): linkedin_list_workspaces
// answers the workspaces after the run's cursor, in id order, STATUS_REFRESH_PAGE_SIZE at most, or,
// under APP_ENV=test only, the size a worker test sets through useStatusRefreshPageSize, so that a
// test continues a run as new over a few workspaces; any other environment refuses it.
import { platformConfig } from "@whytide/platform";
import { STATUS_REFRESH_PAGE_SIZE } from "./constants.ts";

let pageSize = STATUS_REFRESH_PAGE_SIZE;

/** For the worker's tests: the workspaces a page holds; undefined puts the constant back. */
export function useStatusRefreshPageSize(size: number | undefined): void {
  if (platformConfig.APP_ENV !== "test") {
    throw new Error("useStatusRefreshPageSize: only under APP_ENV=test");
  }
  pageSize = size ?? STATUS_REFRESH_PAGE_SIZE;
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

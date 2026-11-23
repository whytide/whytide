// The tick's activity (README "What starts a run"): each workspace with a held lead gets its batch
// started, unless one runs; the check is a run of the workspace's own (contacts' list, limit 1). A
// workspace that fails leaves the others started, and the tick then fails with its code. Counts only.
import { leadsHeldForEnrichment } from "@whytide/contacts";
import { startWorkflow } from "@whytide/platform";
import { listWorkspaceIds } from "@whytide/tenancy";
import { batchStart } from "../events.ts";
import { inWorkspace } from "./store.ts";

export async function startBatches(): Promise<{ workspaces: number; started: number }> {
  const workspaceIds = await listWorkspaceIds();
  let started = 0;
  const failures: unknown[] = [];
  for (const workspaceId of workspaceIds) {
    try {
      const held = await inWorkspace(workspaceId, () => leadsHeldForEnrichment({ limit: 1 }));
      if (held.length > 0 && (await startWorkflow(batchStart(workspaceId))).started) started += 1;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
  return { workspaces: workspaceIds.length, started };
}

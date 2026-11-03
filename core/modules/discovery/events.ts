// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"): ids only.
// Its own subscriber starts an import's run in the worker (platform README "Workflows").
import { currentTenant, defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";
import { CHUNK_SIZE } from "./domain/import/chunks.ts";

export const events = defineEvents({
  /**
   * A chunk of an import's run committed (docs/flows.md "Run"): the persons it created or updated,
   * each with its lead, 500 at most; qualification picks them up (alpha-p6-040).
   */
  "discovery.people_imported": z.strictObject({
    workspaceId: z.string(),
    jobId: z.string(),
    personIds: z.array(z.string()).min(1).max(CHUNK_SIZE),
  }),
  /** POST …/imports/{job}/run claimed job `jobId`: the worker starts its run. */
  "discovery.import_run_requested": z.strictObject({
    workspaceId: z.string(),
    jobId: z.string(),
  }),
});

// One run per job: the starter answers { started: false } for an id that is running or has run, so a
// second delivery starts none. The workspace is the delivery's tenant run, never the payload's.
subscribe(events["discovery.import_run_requested"], async ({ jobId }) => {
  const { workspaceId } = currentTenant();
  await startWorkflow({
    workflow: "discovery_import_run",
    input: { workspaceId, jobId },
    workflowId: `discovery.import_run:${workspaceId}:${jobId}`,
  });
});

// The events this module publishes, written to the outbox in the same transaction as the change
// (docs/rules/coding.md §2, §3; core/packages/platform/README.md "Events and the outbox"), and its
// own subscriptions: a requested run starts its workflow, named by the run, so a redelivery starts
// none (README "What starts a run"); a requested email lookup starts its workflow, named by the
// request and its attempt (README "Email lookups"). Ids, enums and codes only, never an address.
import type { TenantClient } from "@whytide/db";
import {
  currentTenant,
  defineEvents,
  type EventContext,
  startWorkflow,
  subscribe,
} from "@whytide/platform";
import { z } from "zod";
import { MISSING_REASONS } from "./domain/lookup/constants.ts";

export const events = defineEvents({
  /** A member asked for a person's run (requestEnrichment): its id only. */
  "enrichment.run_requested": z.strictObject({ runId: z.string() }),
  /** A lookup or a re-verification was asked for (requestLookup, requestReverification). */
  "enrichment.lookup_requested": z.strictObject({ requestId: z.string() }),
  /** A lookup ended with a verified address: the contact point's id, never the address. */
  "enrichment.address_verified": z.strictObject({
    requestId: z.string(),
    personId: z.string(),
    contactPointId: z.string(),
  }),
  /** A lookup ended without a usable address, and why. */
  "enrichment.address_missing": z.strictObject({
    requestId: z.string(),
    personId: z.string(),
    reason: z.enum(MISSING_REASONS),
  }),
});

/** The start of one run's workflow: the batch's child and the request's subscriber name it alike. */
export function runStart(workspaceId: string, runId: string) {
  return {
    workflow: "enrichment_run",
    input: { workspaceId, runId },
    workflowId: `enrichment.run:${workspaceId}:${runId}`,
  };
}

/** The start of the workspace's batch: one at a time by its fixed id. */
export function batchStart(workspaceId: string) {
  return {
    workflow: "enrichment_batch",
    input: { workspaceId },
    workflowId: `enrichment.batch:${workspaceId}`,
    oneAtATime: true,
  };
}

/** The start of a lookup's attempt: a request asked again runs as a new workflow. */
export function lookupStart(workspaceId: string, requestId: string, attempt: number) {
  return {
    workflow: "enrichment_lookup",
    input: { workspaceId, requestId },
    workflowId: `enrichment.lookup:${workspaceId}:${requestId}:${attempt}`,
  };
}

// The workspace is the delivery's tenant run, never the payload's.
subscribe(events["enrichment.run_requested"], async ({ runId }) => {
  await startWorkflow(runStart(currentTenant().workspaceId, runId));
});

// The request's attempt as the delivery's run reads it; a request erased since starts nothing.
subscribe(
  events["enrichment.lookup_requested"],
  async ({ requestId }, { tx }: EventContext<TenantClient>) => {
    const request = await tx.enrichmentRequest.findFirst({
      where: { id: requestId },
      select: { attempt: true },
    });
    if (request === null) return;
    await startWorkflow(lookupStart(currentTenant().workspaceId, requestId, request.attempt));
  },
);

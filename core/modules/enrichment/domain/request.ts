// A run on request (README "Public interface"; gamma-en-055's button and route), in the caller's
// tenant run: the run written with its key, `request:<requestKey>`, and enrichment.run_requested
// published in the same run, so the event exists exactly when the run does; its subscriber starts the
// workflow (events.ts). A key given again answers its run and publishes nothing. A request is asked
// whatever the retry days say (docs/flows.md "The run").
import { errors as contactsErrors, getPerson } from "@whytide/contacts";
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, isAppError, publish } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { createRun } from "./runs.ts";

const requestInput = z.strictObject({
  personId: z.string().trim().min(1).max(64),
  requestKey: z.string().trim().min(1).max(200),
});

/**
 * The person's run for the key: `created` false when the key had one. enrichment_input_invalid
 * naming the fields off the rule, enrichment_person_not_found for no person of the workspace.
 */
export async function requestEnrichment(input: {
  personId: string;
  requestKey: string;
}): Promise<{ runId: string; created: boolean }> {
  const parsed = requestInput.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    throw new AppError(errors.enrichment_input_invalid, { details: { fields } });
  }
  const { personId, requestKey } = parsed.data;
  try {
    await getPerson(personId);
  } catch (error) {
    if (isAppError(error) && error.code === contactsErrors.person_not_found) {
      throw new AppError(errors.enrichment_person_not_found);
    }
    throw error;
  }
  const run = await createRun({
    personId,
    trigger: "request",
    requestKey: `request:${requestKey}`,
  });
  if (run.created) {
    const outbox = outboxWriter(tenantClient, currentTenant().workspaceId);
    await publish(outbox, events["enrichment.run_requested"], { runId: run.runId });
  }
  return run;
}

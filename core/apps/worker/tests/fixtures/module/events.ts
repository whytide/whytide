// The fixture module's events and its own subscribers: one keeps the ids it was delivered; the other
// starts fixture_echo by an id from its request, as a route's subscriber does (platform README
// "Workflows"), keeps what startWorkflow answered, then fails its first delivery, as one lost before
// its row's mark, so that the event comes again.
import { defineEvents, startWorkflow, subscribe } from "@whytide/platform";
import { z } from "zod";

export const events = defineEvents({
  "fixture.pinged": z.strictObject({ ping_id: z.string() }),
  "fixture.requested": z.strictObject({ request_id: z.string() }),
});
export const received: string[] = [];
export const starts: { readonly id: string; readonly started: boolean }[] = [];

subscribe(events["fixture.pinged"], async (_payload, { id }) => {
  received.push(id);
});

subscribe(events["fixture.requested"], async ({ request_id }, { id, workspaceId, attempt }) => {
  const workflowId = `fixture.echo:${workspaceId}:${request_id}`;
  const input = { workspaceId };
  const { started } = await startWorkflow({ workflow: "fixture_echo", input, workflowId });
  starts.push({ id, started });
  if (attempt === 1) throw new Error("fixture: lost after the start");
});

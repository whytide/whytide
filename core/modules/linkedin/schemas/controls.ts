// The body and the answer of the controls routes (README.md "API"): the platform's switches, which
// the operator's command sets, and the workspace's "Stop everything", which the screen sets.
import { z } from "zod";
import { switchSource } from "./accounts.ts";

export const controlsBody = z.strictObject({
  /** The workspace's stop on or off: off lifts the tester's stop, never the operator's. */
  stopped: z.boolean(),
});
export type ControlsBody = z.infer<typeof controlsBody>;

export const controlsResponse = z.strictObject({
  platform: z.strictObject({
    /** Sends may go out on the instance: false until the operator opens sending. */
    sendingOpen: z.boolean(),
    /** The operator stopped every LinkedIn action on the instance, reads included. */
    stopped: z.boolean(),
    /** No connection request goes out on the instance (the fleet breaker); messages do. */
    invitesPaused: z.boolean(),
  }),
  workspace: z.strictObject({
    /** Every LinkedIn action of the workspace is stopped, reads included. */
    stopped: z.boolean(),
    /** Who stopped it, null while it is not stopped. */
    stopSource: switchSource.nullable(),
  }),
});
export type ControlsResponse = z.infer<typeof controlsResponse>;

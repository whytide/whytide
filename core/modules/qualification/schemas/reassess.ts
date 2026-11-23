// A member's new assessment of a lead, as `POST …/qualification/leads/{personId}/reassess` takes and
// answers it (README "A new assessment"): the lead's person, as the snapshot read names it; the
// lead's status after the press, and whether the press asked for anything, false for a lead that
// waits already.
import { z } from "zod";
import { snapshotParams } from "./snapshot.ts";

export const reassessParams = snapshotParams;
export const reassessResponse = z.strictObject({
  status: z.literal("pending"),
  requested: z.boolean(),
});
export type ReassessResponse = z.infer<typeof reassessResponse>;

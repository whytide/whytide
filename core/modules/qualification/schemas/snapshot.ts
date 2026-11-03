// The answer of qualification's snapshot read (README.md "Routes"), from which the api builds its
// OpenAPI document: the lead's current snapshot, its time as an ISO string.
import { z } from "zod";
import { CRITERIA, DISQUALIFIERS, VERDICTS } from "./assess-fit.ts";

export const snapshotParams = z.strictObject({ personId: z.string().min(1).max(64) });
export const snapshotResponse = z.strictObject({
  snapshotId: z.string(),
  personId: z.string(),
  status: z.enum(["assessed", "qualified", "not_qualified", "needs_review"]),
  fitScore: z.int().nullable(),
  confidence: z.enum(["high", "medium", "low"]).nullable(),
  tier: z.enum(["hot", "warm", "cool"]).nullable(),
  icpVersion: z.int(),
  scorerVersion: z.string().nullable(),
  /** The model's one sentence; the screen labels it as the model's. */
  summary: z.string(),
  disqualifiers: z.array(z.enum(DISQUALIFIERS)),
  /** The six verdicts in the criteria's order: weight and points are null until scored. */
  verdicts: z.array(
    z.strictObject({
      criterion: z.enum(CRITERIA),
      verdict: z.enum(VERDICTS),
      evidence: z.string(),
      weight: z.int().nullable(),
      points: z.number().nullable(),
    }),
  ),
  scoredAt: z.string(),
});
export type SnapshotResponse = z.infer<typeof snapshotResponse>;

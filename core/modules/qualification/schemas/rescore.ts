// The re-score's request, as `POST …/qualification/rescore` and `pnpm rescore` send it (README "The
// re-score"): every scored lead of the workspace, or the named persons.
import { z } from "zod";

export const rescoreBody = z.strictObject({
  personIds: z.array(z.string().min(1).max(64)).min(1).max(500).optional(),
});
export type RescoreBody = z.infer<typeof rescoreBody>;

/** The request's id, which names the worker's run, and the leads it marked: those the run moves. */
export const rescoreResponse = z.strictObject({ requestId: z.string(), marked: z.int().min(0) });
export type RescoreResponse = z.infer<typeof rescoreResponse>;

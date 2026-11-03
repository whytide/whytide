// The request of inbox's export route (README.md "The reply golden set"), from which the api builds
// its OpenAPI document; the answer is a JSON Lines file, which the document does not describe.
import { z } from "zod";
import { ISO_WEEK } from "../domain/export/constants.ts";

export const replyLabelsQuery = z.strictObject({
  /**
   * An ISO week, `2026-W44`, in UTC: the labels chosen in it. week_invalid for a week its year does
   * not have, or one that has not started.
   */
  week: z.string().regex(ISO_WEEK).optional(),
});
export type ReplyLabelsQuery = z.output<typeof replyLabelsQuery>;

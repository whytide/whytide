// The request of qualification's golden-set route (README.md "The golden set"), from which the api
// builds its OpenAPI document; the answer is a JSON Lines file, which the document does not describe.
import { z } from "zod";

export const goldenSetQuery = z.strictObject({
  /** An ISO week, `2026-W43`, in UTC: the leads whose latest decision was made in it. */
  week: z
    .string()
    .regex(/^\d{4}-W\d{2}$/)
    .optional(),
});
export type GoldenSetQuery = z.infer<typeof goldenSetQuery>;

// noteItemWait (README.md "Public interface", "Decided here"): campaigns' sender tells approvals why
// an approved step waits (`insufficient_credits`, the note budget), or that it waits no longer, so
// "Up next" can say so; approvals never reads campaigns. Not in the sources: the task adds it here
// so that the sender's tasks only call it (beta-p4-020, beta-p4-040).
import { tenantClient } from "@whytide/db";
import { instant } from "@whytide/platform";
import { z } from "zod";
import { WAIT_CODE } from "./constants.ts";
import { id, parse } from "./store.ts";

const waitInput = z
  .object({ code: z.string().regex(WAIT_CODE), until: instant.nullable().default(null) })
  .nullable();
/** Why the step waits, a code, and until when, if known; null clears it. */
export type ItemWait = z.input<typeof waitInput>;

/**
 * Sets or clears the wait of the step's approved item; the items changed, 0 when the step has no
 * approved item. approvals_input_invalid for a code off WAIT_CODE.
 */
export async function noteItemWait(stepExecutionId: string, wait: ItemWait): Promise<number> {
  const step = parse(id, stepExecutionId);
  const noted = parse(waitInput, wait);
  const data =
    noted === null
      ? { waitCode: null, waitUntil: null }
      : { waitCode: noted.code, waitUntil: noted.until };
  const where = { stepExecutionId: step, status: "approved" as const };
  const { count } = await tenantClient.approvalItem.updateMany({ where, data });
  return count;
}

// The sends the action log recorded (README.md "Public interface"), in the caller's tenant run: the
// record of what went out, which campaigns' "Done when" report (beta-p7-020) starts its zeros from.
// A send's row names its step execution (schemas/quota.ts logInput); an object that is no step
// execution's id is answered as none, so no post URL or person id leaves through this read.
import { tenantClient } from "@whytide/db";
import { instant } from "@whytide/platform";
import { z } from "zod";
import { type SendActionType, STEP_EXECUTION_ID, sendActionTypes } from "../../schemas/quota.ts";
import { parseInput } from "../input.ts";

/** An `ok` row of a send: ids, its kind and its instant. */
export type SendLogRow = {
  readonly id: string;
  /** The send's step execution (`sx_`), or null for a row that names none. */
  readonly stepExecutionId: string | null;
  readonly senderAccountId: string;
  readonly kind: SendActionType;
  readonly at: Date;
};

const sinceInput = z.strictObject({ since: instant });

/**
 * The `ok` rows of kinds invite, message and withdraw at or after `since`, oldest first, in the run's
 * workspace only. read_input_invalid naming `since` for no instant.
 */
export async function sendLogRows(input: { readonly since: Date | string }): Promise<SendLogRow[]> {
  const { since } = parseInput(sinceInput, input);
  const rows = await tenantClient.senderActionLog.findMany({
    where: { outcome: "ok", kind: { in: [...sendActionTypes] }, at: { gte: since } },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    select: { id: true, objectRef: true, senderAccountId: true, kind: true, at: true },
  });
  return rows.map(({ id, objectRef, senderAccountId, kind, at }) => ({
    id,
    stepExecutionId: objectRef !== null && STEP_EXECUTION_ID.test(objectRef) ? objectRef : null,
    senderAccountId,
    kind: kind as SendActionType,
    at,
  }));
}

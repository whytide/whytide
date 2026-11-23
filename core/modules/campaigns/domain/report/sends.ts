// The sends the zeros check, and send_step_missing (README.md "Commands"), in the caller's tenant run:
// linkedin's `ok` rows of the period, the record of what went out, each with its step execution when
// it still exists. The zeros start here, never from campaigns' own view of its steps, so a send that
// bypassed campaigns shows as a row whose step is missing.
import { type Prisma, tenantClient } from "@whytide/db";
import { type SendLogRow, sendLogRows } from "@whytide/linkedin";
import { ACTION_KINDS, type ActionKind } from "./constants.ts";

/**
 * A send's step as the zeros read it: ids, its campaign's key_ref (the approval's lock, gamma-p4-070)
 * and what the gate stored with the send, never a text.
 */
export type SentStep = {
  readonly id: string;
  readonly personId: string;
  readonly templateId: string;
  readonly jitChecks: Prisma.JsonValue | null;
};
/** An invite or a message that went out, with its step. */
export type Send = {
  readonly row: SendLogRow & { readonly kind: ActionKind };
  readonly step: SentStep;
};
export type Sends = {
  /** Every `ok` row of the period, withdrawals included, oldest first. */
  readonly rows: readonly SendLogRow[];
  /** The invites and messages whose step execution exists. */
  readonly sends: readonly Send[];
  /** The rows whose step execution no longer exists, or that name none: send_step_missing. */
  readonly missing: readonly SendLogRow[];
};

/** The period's `ok` rows, split by whether their step still exists (the file's header). */
export async function readSends(period: { readonly since: Date }): Promise<Sends> {
  const rows = await sendLogRows({ since: period.since });
  const ids = [...new Set(rows.flatMap(({ stepExecutionId: id }) => (id === null ? [] : [id])))];
  const steps =
    ids.length === 0
      ? []
      : await tenantClient.stepExecution.findMany({
          where: { id: { in: ids } },
          select: { id: true, personId: true, templateId: true, jitChecks: true },
        });
  const byId = new Map(steps.map((step) => [step.id, step]));
  const sends: Send[] = [];
  const missing: SendLogRow[] = [];
  for (const row of rows) {
    const step = row.stepExecutionId === null ? undefined : byId.get(row.stepExecutionId);
    if (step === undefined) missing.push(row);
    else if (isAction(row)) sends.push({ row, step });
  }
  return { rows, sends, missing };
}

/** An invite or a message: what the zeros check. */
export const isAction = (row: SendLogRow): row is SendLogRow & { readonly kind: ActionKind } =>
  (ACTION_KINDS as readonly string[]).includes(row.kind);

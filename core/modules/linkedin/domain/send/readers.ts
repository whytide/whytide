// The send reservations as the send activities read them (beta-p1-050), inside this module only: one
// by id, and the reservations of one key, which tell whether a twin's send went out.
import { tenantClient } from "@whytide/db";
import type { SendActionType } from "../../schemas/quota.ts";
import type { HoldStatus } from "../quota/holds.ts";

export type SendReservationRow = {
  readonly id: string;
  readonly senderAccountId: string;
  readonly actionType: SendActionType;
  readonly idempotencyKey: string;
  readonly status: HoldStatus;
  readonly expiresAt: Date;
  /** An invite's note, which the month's budget counted. */
  readonly withNote: boolean;
  readonly createdAt: Date;
};
const SHOWN = {
  id: true,
  senderAccountId: true,
  actionType: true,
  idempotencyKey: true,
  status: true,
  expiresAt: true,
  withNote: true,
  createdAt: true,
} as const;

/** A send reservation of the run's workspace, or null; a read's is none. */
export async function findSendReservation(id: string): Promise<SendReservationRow | null> {
  const row = await tenantClient.senderQuotaReservation.findFirst({
    where: { id, actionType: { not: "read" } },
    select: SHOWN,
  });
  return row === null ? null : asSend(row);
}

/** The key's reservations in the run's workspace, whatever their status, oldest first. */
export async function reservationsOfKey(idempotencyKey: string): Promise<SendReservationRow[]> {
  const rows = await tenantClient.senderQuotaReservation.findMany({
    where: { idempotencyKey, actionType: { not: "read" } },
    select: SHOWN,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(asSend);
}

function asSend(row: {
  id: string;
  senderAccountId: string;
  actionType: SendActionType | "read";
  idempotencyKey: string | null;
  status: HoldStatus;
  expiresAt: Date;
  withNote: boolean;
  createdAt: Date;
}): SendReservationRow {
  const { actionType, idempotencyKey } = row;
  // The key's CHECK: a send's reservation always carries its key, a read's never.
  if (actionType === "read" || idempotencyKey === null) throw new Error("a read among the sends");
  return { ...row, actionType, idempotencyKey };
}

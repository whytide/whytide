// A send's settle (docs/flows.md "Sends"): commitSend counts the send on its reservation's own day
// row once it went out, a reservation released or expired meanwhile included, and an invite in the
// account's pending invitations until the next check (domain/invites/), but with `pending` false (an
// invitation LinkedIn refused, its person a connection already); releaseSend frees a slot
// whose send did not go out. Each locks the day's row first (quota/holds.ts), as the read settles
// do, an invite's commit its account's row before it, and moves only the counters of the
// reservation's own action type. holdSendUntil keeps a slot past its hold while its send's outcome
// is unknown.
import { tenantClient } from "@whytide/db";
import { releaseInput } from "../../schemas/quota.ts";
import { parseInput } from "../input.ts";
import { type Held, lockAccountRow, lockReservation, notOpen, settle } from "../quota/holds.ts";

export type SettledSend = {
  readonly reservationId: string;
  /** `committed_late`: committed after its release or expiry while another reservation held its key. */
  readonly status: "committed" | "committed_late";
};

/**
 * The send counted once: a repeat answers as the first. A released or expired reservation still
 * counts, since the send went out; when another reservation holds its key meanwhile, it becomes
 * `committed_late`, counted, outside the partial unique index. A read's is `reservation_not_open`.
 * An invite's adds one to the account's pending invitations, unless `pending` is false.
 */
export async function commitSend(
  reservationId: string,
  options: { readonly pending?: boolean } = {},
): Promise<SettledSend> {
  const { pending = true } = options;
  const valid = parseInput(releaseInput, { reservationId });
  const invite = await tenantClient.senderQuotaReservation.findFirst({
    where: { id: valid.reservationId, actionType: "invite" },
    select: { senderAccountId: true },
  });
  // The account's row before the day's (quota/holds.ts): the commit adds to its pending count.
  if (invite !== null) await lockAccountRow(invite.senderAccountId);
  const held = await lockReservation(valid.reservationId);
  if (held.actionType === "read") throw notOpen(held.id);
  if (held.status === "committed" || held.status === "committed_late") {
    return { reservationId: held.id, status: held.status };
  }
  const late = held.status !== "reserved" && (await heldElsewhere(held));
  const status = late ? "committed_late" : "committed";
  await settle(held, status, 1);
  if (held.actionType === "invite" && pending) await countPending(held.senderAccountId);
  return { reservationId: held.id, status };
}

/** One more invitation pending, in the commit's run, unless the count is unknown: the next check counts it. */
async function countPending(senderAccountId: string): Promise<void> {
  await tenantClient.senderAccount.updateMany({
    where: { id: senderAccountId, pendingInvites: { not: null } },
    data: { pendingInvites: { increment: 1 } },
  });
}

/**
 * Frees the slot; a repeat, or a reservation the sweep freed, changes nothing. A committed one, or a
 * read's, is `reservation_not_open`.
 */
export async function releaseSend(reservationId: string): Promise<void> {
  const valid = parseInput(releaseInput, { reservationId });
  const held = await lockReservation(valid.reservationId);
  const committed = held.status === "committed" || held.status === "committed_late";
  if (held.actionType === "read" || committed) throw notOpen(held.id);
  if (held.status === "reserved") await settle(held, "released", 0);
}

/**
 * The slot held until `until` at least, while its send's outcome is unknown, so that the check after
 * the pause finds it held (beta-p1-050); a settled reservation, or one held longer, is left. A pause
 * keeps such a slot because its expiry lies past created_at + SEND_RESERVATION_MS (health/apply.ts
 * keptForCheck): `until` must stay later than that.
 */
export async function holdSendUntil(reservationId: string, until: Date): Promise<void> {
  const held = await lockReservation(reservationId);
  if (held.actionType === "read" || held.status !== "reserved" || held.expiresAt >= until) return;
  await tenantClient.senderQuotaReservation.update({
    where: { id: held.id },
    data: { expiresAt: until },
  });
}

/** Whether another reservation holds the key: reserved, its hold over or not, or committed. */
async function heldElsewhere(held: Held): Promise<boolean> {
  if (held.idempotencyKey === null) return false;
  const other = await tenantClient.senderQuotaReservation.findFirst({
    where: {
      idempotencyKey: held.idempotencyKey,
      status: { in: ["reserved", "committed"] },
      id: { not: held.id },
    },
    select: { id: true },
  });
  return other !== null;
}

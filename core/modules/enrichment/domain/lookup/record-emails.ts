// `pnpm -F enrichment emails:record`'s work (gamma-rf-040; README.md "Email lookups"), in the caller's
// tenant run: the workspace's contact points read in batches of ids, whatever their status, and each
// one's address recorded for its person by contacts' recordPersonEmail, in a run of its own. Safe to
// run again: an address recorded already answers its person again. No contact point is changed or
// deleted. Ids and counts only, never an address.
import { recordPersonEmail } from "@whytide/contacts";
import { tenantClient } from "@whytide/db";
import { EMAIL_KINDS, RECORD_BATCH } from "./constants.ts";

/**
 * What recording one contact point's address did: recorded for its person, recorded and blocked by a
 * never-contact entry on every channel or on email, or not recorded as another person of the
 * workspace holds it (or an erased one left it); `gone` for a contact point erased meanwhile.
 */
export type RecordOutcome = "recorded" | "blocked" | "other_person" | "gone";

/** The run's workspace's contact points after `after` in id order, RECORD_BATCH at most. */
export async function contactPointsAfter(after: string | null): Promise<string[]> {
  const rows = await tenantClient.contactPoint.findMany({
    // Addresses only: a phone has no hash to record (gamma-wr-100).
    where: { kind: { in: [...EMAIL_KINDS] }, ...(after !== null && { id: { gt: after } }) },
    select: { id: true },
    orderBy: { id: "asc" },
    take: RECORD_BATCH,
  });
  return rows.map(({ id }) => id);
}

/**
 * Records the contact point's address for its person; contacts_input_invalid for a value that is no
 * address (recordPersonEmail).
 */
export async function recordContactPoint(id: string): Promise<RecordOutcome> {
  const point = await tenantClient.contactPoint.findFirst({
    where: { id, kind: { in: [...EMAIL_KINDS] } },
    select: { personId: true, value: true },
  });
  if (point === null) return "gone";
  const { holder, suppressed } = await recordPersonEmail({
    personId: point.personId,
    address: point.value,
  });
  if (holder === "other_person") return "other_person";
  return suppressed ? "blocked" : "recorded";
}

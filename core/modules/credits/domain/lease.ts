// The lease of a reservation (docs/concepts.md "Lease"): a `sync` one holds 15 minutes, for work done
// inside a request, an `async` one 24 hours, for a workflow's. From its end on, commit refuses the
// reservation and the next reserve of its organization expires it, which frees its credits.
import type { CreditsLease } from "@whytide/platform";

export const LEASE_MS: Readonly<Record<CreditsLease, number>> = {
  sync: 15 * 60_000,
  async: 24 * 60 * 60_000,
};

/** When a reservation made at `at` stops holding; it is expired at that instant and after. */
export function leaseExpiresAt(lease: CreditsLease, at: Date): Date {
  return new Date(at.getTime() + LEASE_MS[lease]);
}

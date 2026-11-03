// The credit period (docs/concepts.md "Period"): the calendar month in UTC. credits_seed_self_hosted
// computes the same period in SQL from the database's clock (the migration); this is its rule in code,
// for the callers that need the bounds.

export type Period = { readonly start: Date; readonly end: Date };

/** The calendar month in UTC holding the instant, from its first instant to the next month's, excluded. */
export function periodFor(at: Date): Period {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return { start: new Date(Date.UTC(year, month, 1)), end: new Date(Date.UTC(year, month + 1, 1)) };
}

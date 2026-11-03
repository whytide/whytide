// The instant a check or a stop is made at (README.md "The gate"): a caller's own code passes it, so
// anything but a valid date is a developer's mistake, thrown as one, before anything is read.

/** The instant, when `value` is a valid date; an error naming `field` otherwise. */
export function requireInstant(value: unknown, field: string): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  throw new Error(`${field}: no instant`);
}

// How long linkedin keeps its operational rows (docs/data.md; data model §6.2), which the daily job
// deletes (purge.ts), and how many rows one statement deletes.

/** Days an event's receipt is kept from its `received_at`: the vendor redelivers within them. */
export const EVENT_RECEIPT_DAYS = 7;

/** Days an action-log row is kept from its `at` (data model §6.2, F10 R8). */
export const ACTION_LOG_DAYS = 90;

/** Rows a purge statement deletes at most, so that no run holds its locks long (not in sources). */
export const PURGE_BATCH_ROWS = 5000;

// The thread reads' constants (README.md "API"), beside their readers.

/** The most threads a page of the list holds, and its size when the query names none (not in the sources). */
export const THREADS_PAGE_MAX = 50;
/** The longest cursor the list takes: base64url of a time and an id. */
export const CURSOR_MAX = 200;
/** A message's directions: the person's (`in`) and the account's (`out`), as the table's enum. */
export const DIRECTIONS = ["in", "out"] as const;
export type Direction = (typeof DIRECTIONS)[number];
/** Who sent an outbound message: the platform's campaign or the user on LinkedIn. */
export const SENDERS = ["campaign", "user"] as const;

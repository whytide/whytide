// The inbox's screens' tunable values, beside the code that reads them (docs/rules/coding.md
// "constants").

/** The threads a read of the list asks for, "Load more" the next as many (the api's: 50 at most). */
export const PAGE_SIZE = 20;

/** The loading state's rows: as many as fill the first screen. */
export const LOADING_ROWS = 6;

/** The loading state's shimmering lines of the thread: a message's card each. */
export const LOADING_LINES = [3, 2, 3] as const;

/** A message's time, and the time the list shows: the day and the minute, in the reader's zone. */
export const TIME_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const;

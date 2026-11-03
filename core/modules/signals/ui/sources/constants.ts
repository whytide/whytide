// The sources screen's constants (README.md "Screen"): the status of a sender account a run reads
// through, where an open run's line links, its id, by which Run now names it, how often the list is
// read again while a run reads or one Run now asked for has not started, and the cards the loading
// state shows.

/** The status, in linkedin's accounts, of a sender account a run can read through. */
export const CONNECTED = "connected";

/** The workspace's LinkedIn screen, where a sender account is connected again. */
export const linkedinScreen = (workspaceId: string): string => `/w/${workspaceId}/linkedin`;

/** The id of a source's open-run line, in its card, while a run of the source is open. */
export const runStateId = (sourceId: string): string => `signals-run-state-${sourceId}`;

/** How often the list is read again while a run reads, or until a run Run now asked for starts. */
export const SOURCES_POLL_MS = 15_000;

/** The loading state's skeletons: the add form's lines, the source cards and theirs, the runs' rows. */
export const SKELETON = { formLines: 2, cards: 2, cardLines: 4, runRows: 3 } as const;

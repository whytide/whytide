// The prompt's tunable values (README "The prompt at sign-in"), beside the code that reads them; its
// polling and the run's stuck rule are the Company screen's (../company/constants.ts).

/** The sessionStorage key of a prompt skipped or done in this tab, one per workspace: `<key>:<id>`. */
export const HIDDEN_KEY = "whytide.onboarding.get-started.hidden";

/**
 * How long the ICP's automatic draft may go without a change before the card calls it stuck: ten
 * minutes, counted from the later of the Company Knowledge's save and the ICP's last change, so the
 * Company Knowledge's run is never in it (progress.ts, outcomeOf).
 */
export const ICP_STUCK_MS = 10 * 60_000;

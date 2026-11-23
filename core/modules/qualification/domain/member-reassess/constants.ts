// A member's new assessment of a lead (README "A new assessment"), beside its readers: the press
// (index.ts) and the batch's rounds of attempts (rounds.ts, workflows/batch.ts).

/** The lead's status_reason while it waits for the assessment a member asked for. */
export const MEMBER_REQUESTED = "member_requested";

/**
 * A lead's attempts at one ICP version come in rounds of this many: the provider failing the last
 * of a round makes the lead ai_failed, before it the lead waits for a later batch. A member's press
 * starts the next round.
 */
export const ATTEMPTS_PER_ROUND = 3;

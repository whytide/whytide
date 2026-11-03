// The account's health states and what a signal does in each (README.md "Health"; docs/concepts.md
// "Health"), pure: applyHealth (apply.ts) writes what transitionOf answers, and the refusals
// (send/state.ts, quota/reservations.ts) read isPaused.

export type HealthState = "healthy" | "at_risk" | "restricted" | "checkpoint" | "disconnected";
/** What happened: a warning, a session lost or back, the daily check's rate, the owner's resume. */
export type HealthSignal =
  | "restricted"
  | "checkpoint"
  | "disconnected"
  | "reconnected"
  | "at_risk"
  | "recovered"
  | "resumed";
export type HealthTrigger =
  | "acceptance_rate"
  | "rate_limit_errors"
  | "checkpoint"
  | "limit_reached"
  | "session_invalid"
  | "manual";
export type HealthAction = "paused_all_actions" | "paused_invites" | "resumed";

/** The states that refuse every send and read of the account, account_paused. */
export const PAUSED_STATES: readonly HealthState[] = Object.freeze([
  "restricted",
  "checkpoint",
  "disconnected",
]);
/** The states of a cool-down, paused_until set. */
export const COOLDOWN_STATES: readonly HealthState[] = Object.freeze(["restricted", "checkpoint"]);
/**
 * The states a change into trips the fleet breaker (breaker.ts), whatever its trigger: a
 * restriction or a checkpoint; never at_risk or a lost session (RB-11.3.2, reduced for beta).
 */
export const BREAKER_STATES: readonly HealthState[] = Object.freeze(["restricted", "checkpoint"]);
/** The warnings healthEventsSince answers (events.ts): a restriction or a checkpoint (beta-p7-020). */
export const WARNING_STATES = Object.freeze(["restricted", "checkpoint"] as const);
export type WarningState = (typeof WARNING_STATES)[number];
/** What a change into the state does on its own. */
export const ACTIONS: Readonly<Record<HealthState, HealthAction>> = Object.freeze({
  healthy: "resumed",
  at_risk: "paused_invites",
  restricted: "paused_all_actions",
  checkpoint: "paused_all_actions",
  disconnected: "paused_all_actions",
});

export const isPaused = (state: HealthState): boolean => PAUSED_STATES.includes(state);

/**
 * What a signal does in a state: the state it moves to; `extend`, its cool-down moved on, no change;
 * or null, nothing. restricted from healthy, at_risk or disconnected, and extends a cool-down;
 * checkpoint from any state but checkpoint, which it extends; disconnected from healthy or at_risk
 * only (C26); reconnected from disconnected only; at_risk from healthy; recovered from at_risk;
 * resumed from restricted or checkpoint, the owner's resume (health/resume.ts).
 */
export function transitionOf(
  state: HealthState,
  signal: HealthSignal,
): HealthState | "extend" | null {
  switch (signal) {
    case "restricted":
      return COOLDOWN_STATES.includes(state) ? "extend" : "restricted";
    case "checkpoint":
      return state === "checkpoint" ? "extend" : "checkpoint";
    case "disconnected":
      return state === "healthy" || state === "at_risk" ? "disconnected" : null;
    case "reconnected":
      return state === "disconnected" ? "healthy" : null;
    case "at_risk":
      return state === "healthy" ? "at_risk" : null;
    case "recovered":
      return state === "at_risk" ? "healthy" : null;
    case "resumed":
      return COOLDOWN_STATES.includes(state) ? "healthy" : null;
  }
}

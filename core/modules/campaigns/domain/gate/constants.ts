// The statuses the gate and the stops read (README.md "The gate", "The hold on reply"), beside the
// code that reads them: gate.ts, suppressed.ts and ../hold.ts.

/** A step not yet handed to the sender: what a reply holds and a suppression cancels. */
export const PENDING_STEP_STATUSES = ["planned", "awaiting_approval", "scheduled"] as const;

/** The statuses the gate checks a step in: scheduled, or executing under the sender's claim. */
export const GATE_STEP_STATUSES = ["scheduled", "executing"] as const;

/** The gate's answer for a step in any other status, or none: never stored. */
export const STEP_NOT_READY = "step_not_ready";

export type GateStepStatus = (typeof GATE_STEP_STATUSES)[number];

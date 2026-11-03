// The enrollment panel's values (README.md "Screens"), beside enrollment.tsx, which reads them: how a
// time shows, the zone of an enrollment whose sender is gone, and each status's badge colour, one of
// ui's Badge tones. The steps still to come are the gate's PENDING_STEP_STATUSES.
import type { EnrollmentStatus, StepStatus } from "../../domain/constants.ts";

/** A time in the sender's zone: the day and the minute. */
export const TIME_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const;

/** The zone of an enrollment whose sender account linkedin no longer holds: the instants' own. */
export const FALLBACK_ZONE = "UTC";

/** An enrollment's badge; `refused`, one that exited as it was made and never started. */
export const ENROLLMENT_TONE = {
  active: "accent",
  replied: "success",
  completed: "neutral",
  exited: "warning",
  refused: "warning",
} as const satisfies Record<EnrollmentStatus | "refused", string>;

/** A step's badge. */
export const STEP_TONE = {
  planned: "neutral",
  awaiting_approval: "warning",
  scheduled: "accent",
  executing: "accent",
  succeeded: "success",
  failed: "danger",
  skipped: "warning",
  held: "warning",
  cancelled: "neutral",
} as const satisfies Record<StepStatus, string>;

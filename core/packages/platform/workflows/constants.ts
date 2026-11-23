// The constants of workflows (README "Workflows"): each activity kind's attempts, at which the
// worker ends an activity's attempts (core/apps/worker/src/retry.ts) and by which defineActivity
// bounds an activity's own `attempts`.
import type { ActivityKind } from "./index.ts";

/** A provider call gets five attempts on Temporal's backoff, AI and database work three. */
export const ACTIVITY_ATTEMPTS: Readonly<Record<ActivityKind, number>> = Object.freeze({
  provider: 5,
  ai: 3,
  db: 3,
});

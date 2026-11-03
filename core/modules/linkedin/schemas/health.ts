// The health routes' bodies and answers (README.md "API", "Health"; beta-p6-040), from which the api
// host builds the OpenAPI document: the account's health as its card reads it, and the owner's
// resume, whose body is empty.
import { z } from "zod";
import { HEALTH_EVENTS_SHOWN, RESUME_REFUSALS } from "../domain/health/constants.ts";
import { accountResponse } from "./accounts.ts";

const state = z.enum(["healthy", "at_risk", "restricted", "checkpoint", "disconnected"]);
const trigger = z.enum([
  "acceptance_rate",
  "rate_limit_errors",
  "checkpoint",
  "limit_reached",
  "session_invalid",
  "manual",
]);
const time = z.iso.datetime();

/** The resume takes nothing: the account is the path's, the owner the session's. */
export const resumeBody = z.strictObject({});

export const healthResponse = z.strictObject({
  state,
  /** The trigger and the time of the change into the state; null for an account never changed. */
  trigger: trigger.nullable(),
  since: time.nullable(),
  /** The cool-down's end, set exactly while restricted or checkpoint. */
  pausedUntil: time.nullable(),
  status: accountResponse.shape.status,
  /** When the worker last read the session's status at the provider. */
  statusCheckedAt: time.nullable(),
  /** The caller is the owner and nothing below refuses the resume now. */
  canResume: z.boolean(),
  /** The first of the resume's refusals, its error code; null when it may resume. */
  resumeBlockedBy: z.enum(RESUME_REFUSALS).nullable(),
  /** The fleet breaker: every account's invites paused until the operator reopens them. */
  invitesPaused: z.boolean(),
  pendingInvites: z.int().nullable(),
  pendingInvitesCheckedAt: time.nullable(),
  /** The last 100 invites at least 7 days old and those accepted; `rate` null under a full sample. */
  acceptance: z.strictObject({
    sample: z.int(),
    accepted: z.int(),
    rate: z.number().nullable(),
  }),
  /** The latest events, newest first: numbers and codes only. */
  events: z
    .array(
      z.strictObject({
        id: z.string(),
        from: state,
        to: state,
        trigger,
        metrics: z.record(z.string(), z.union([z.number(), z.string()])),
        at: time,
        acknowledged: z.boolean(),
      }),
    )
    .max(HEALTH_EVENTS_SHOWN),
});
export type HealthResponse = z.infer<typeof healthResponse>;

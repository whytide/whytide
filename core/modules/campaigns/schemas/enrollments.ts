// The enrollment route's query and answer (README.md "Routes"), from which the api host builds the
// OpenAPI document and the web its client: a person's enrollments, newest first, each with its steps
// by position and its sender account's time zone. Ids, codes and instants only: no message text, no
// provider reference. The codes are open strings, so a code a later task adds reaches the panel,
// which words the ones it knows (ui/enrollment-panel/words.ts).
import { z } from "zod";
import {
  ACTION_TYPES,
  ENROLLMENT_STATUSES,
  EXIT_REASONS,
  ID_MAX,
  STEP_STATUSES,
} from "../domain/constants.ts";

const time = z.iso.datetime();

export const enrollmentsQuery = z.strictObject({ personId: z.string().min(1).max(ID_MAX) });
export type EnrollmentsQuery = z.infer<typeof enrollmentsQuery>;

const step = z.strictObject({
  stepKey: z.string(),
  actionType: z.enum(ACTION_TYPES),
  status: z.enum(STEP_STATUSES),
  /** When the step may go: the connection request's at the enrollment, the others' once their anchor happens. */
  dueAt: time.nullable(),
  /** The send's slot, once the daily plan has placed it. */
  scheduledFor: time.nullable(),
  /** When it was sent. */
  executedAt: time.nullable(),
  /** A code of STEP_REASON_CODES (domain/steps/constants.ts): why it was skipped, held or cancelled. */
  skipReason: z.string().nullable(),
  /** A code of STEP_REASON_CODES: why it waits (`touched_today`) or failed. */
  errorCode: z.string().nullable(),
});

export const enrollmentsResponse = z.strictObject({
  enrollments: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(ENROLLMENT_STATUSES),
      /** Set exactly when `exited`. */
      exitReason: z.enum(EXIT_REASONS).nullable(),
      /** A code of EXIT_DETAILS (domain/steps/constants.ts): the suppression reason behind `suppressed`. */
      exitDetail: z.string().nullable(),
      /** Null for an enrollment that ended as it was made: it never started. */
      startedAt: time.nullable(),
      endedAt: time.nullable(),
      templateId: z.string(),
      templateVersion: z.int(),
      /** The sender account's IANA time zone, which the panel shows the times in; null without a sender. */
      timeZone: z.string().nullable(),
      steps: z.array(step),
    }),
  ),
});
export type EnrollmentsResponse = z.infer<typeof enrollmentsResponse>;

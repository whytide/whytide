// The editor's sequence (README.md "Routes"; gamma-p3-050), pure: PUT …/sequence's body, the
// steps' actions in order, a delay in business days where the member gives one, and the fallback's
// checkbox, as the steps saveVersion takes. A step given a delay is due that many business days
// after the step before it; a step given none takes the fixed delay of its place: the first, the
// connection request, at the enrollment; a LinkedIn message right after it, beta's draw after the
// acceptance; with the fallback, the first email FALLBACK_DELAY after the invitation. Any other step
// without one breaks step_delay, and one of those places given a delay breaks its own rule
// (sequence.ts). emailFallback puts FALLBACK_CONDITION on every email, or on none.
import {
  ENROLLMENT_DELAY,
  FALLBACK_CONDITION,
  FALLBACK_DELAY,
  FIRST_MESSAGE_DELAY,
} from "./constants.ts";
import type { SequenceInput } from "./sequence.ts";

/** A step as the editor sends it. */
export type EditedStep = {
  readonly action: string;
  readonly delayBusinessDays?: number | undefined;
};
/** The editor's list and its fallback's checkbox. */
export type EditedSequence = {
  readonly steps: readonly EditedStep[];
  readonly emailFallback: boolean;
};

/** The editor's list as a sequence, each step's delay and condition from its place (the header). */
export function editedSequence({ steps, emailFallback }: EditedSequence): SequenceInput[] {
  const firstEmail = steps.findIndex(({ action }) => action === "email");
  return steps.map(({ action, delayBusinessDays }, index) => {
    const fixed =
      index === 0
        ? ENROLLMENT_DELAY
        : index === 1 && action === "message"
          ? FIRST_MESSAGE_DELAY
          : emailFallback && index === firstEmail
            ? FALLBACK_DELAY
            : null;
    const delay =
      delayBusinessDays === undefined
        ? fixed
        : { anchor: "prev_step", unit: "business_days", value: delayBusinessDays };
    const marked = emailFallback && action === "email";
    return marked ? { action, delay, condition: FALLBACK_CONDITION } : { action, delay };
  });
}

// When a step falls due after the step before it (README.md "Campaigns and versions"): its delay in
// business days, Monday to Friday whatever days the sender account lists, in the account's time
// zone, through platform's addBusinessDays, with no holiday calendar. The owner's skip and the
// gate's approval block (../steps/skip.ts) read it, and the sender's settle (../send/settle.ts),
// each with the steps of the enrollment's campaign version (gamma-p3-030). Pure: the caller reads
// the zone with linkedin's findSenderAccount, and the steps with ../campaigns/reads.ts versionSteps.
import { addBusinessDays, MONDAY_TO_FRIDAY } from "@whytide/platform";
import { type StepDelay, TEMPLATE_STEPS } from "./constants.ts";

/**
 * The instant step `stepKey` of `steps` (beta's template unless given) falls due, its delay counted
 * from `from` in `timeZone`; null for a step whose delay is not counted from the step before it (the
 * connection request, due at the enrollment, and the first message, due after the acceptance) and
 * for a key the steps lack.
 */
export function nextDueAt(
  stepKey: string,
  from: Date,
  timeZone: string,
  steps: readonly { readonly stepKey: string; readonly delay: StepDelay }[] = TEMPLATE_STEPS,
): Date | null {
  const step = steps.find((candidate) => candidate.stepKey === stepKey);
  if (step === undefined || step.delay.anchor !== "prev_step") return null;
  return addBusinessDays(from, step.delay.value, timeZone, MONDAY_TO_FRIDAY);
}

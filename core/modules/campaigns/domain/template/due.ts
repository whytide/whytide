// When a step falls due after the step before it (README.md "The template"): its delay in business
// days, Monday to Friday whatever days the sender account lists, in the account's time zone, through
// platform's addBusinessDays, with no holiday calendar. The owner's skip and the gate's approval
// block (../steps/skip.ts) read it, and the sender's commit will (beta-p4-020). Pure: the caller
// reads the zone with linkedin's findSenderAccount.
import { addBusinessDays, MONDAY_TO_FRIDAY } from "@whytide/platform";
import { TEMPLATE_STEPS } from "./constants.ts";

/**
 * The instant step `stepKey` falls due, its delay counted from `from` in `timeZone`; null for a
 * step whose delay is not counted from the step before it (the connection request, due at the
 * enrollment, and the first message, due after the acceptance) and for a key the template lacks.
 */
export function nextDueAt(stepKey: string, from: Date, timeZone: string): Date | null {
  const step = TEMPLATE_STEPS.find((candidate) => candidate.stepKey === stepKey);
  if (step === undefined || step.delay.anchor !== "prev_step") return null;
  return addBusinessDays(from, step.delay.value, timeZone, MONDAY_TO_FRIDAY);
}

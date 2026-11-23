// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8):
// the credits of a send, and the sequence's longest delay and the reply actions' days
// (env-settings-a; README.md "Settings"), read once as the module loads, so that a value off its
// range stops the start with config_invalid. The screens never import this file: the editor shows
// the delay the campaign's answer carries.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import {
  MAX_STEP_DELAY_BUSINESS_DAYS,
  MIN_STEP_DELAY_BUSINESS_DAYS,
} from "./domain/campaigns/constants.ts";
import {
  NOT_INTERESTED_COOL_DOWN_DAYS,
  NOT_NOW_REMINDER_DAYS,
  OOO_DEFAULT_PAUSE_DAYS,
  OOO_RESUME_BUSINESS_DAYS,
} from "./domain/replies/constants.ts";
import { CREDITS_PER_LINKEDIN_SEND } from "./domain/send/constants.ts";
import { TEMPLATE_STEPS } from "./domain/template/constants.ts";
import { WARM_SIGNAL_STEPS } from "./domain/template/warm-signal.ts";

const { default: perSend, min, max } = CREDITS_PER_LINKEDIN_SEND;
/**
 * The longest later step's delay of the built-in sequences, beta's template (the seeded campaign's
 * version 1, read through the rules as the module loads) and the warm-signal default: the longest
 * delay's least, so that both always pass its rule (README.md "Settings").
 */
const BUILT_IN_DELAY = Math.max(
  ...[...TEMPLATE_STEPS, ...WARM_SIGNAL_STEPS].map(({ delay }) =>
    delay.anchor === "prev_step" ? delay.value : MIN_STEP_DELAY_BUSINESS_DAYS,
  ),
);
/** A whole number of `least` or more, no maximum, `fallback` unset or empty. */
const whole = (least: number, fallback: number) =>
  z.coerce.number().int().min(least).default(fallback);

export const settings = defineConfig("modules/campaigns", {
  /** The credits of one send, campaigns.linkedin_send's (README.md "Settings"). */
  CAMPAIGNS_CREDITS_PER_LINKEDIN_SEND: z.coerce.number().int().min(min).max(max).default(perSend),
  /** A later step's longest delay after the one before, in business days, BUILT_IN_DELAY or more. */
  CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS: whole(
    BUILT_IN_DELAY,
    MAX_STEP_DELAY_BUSINESS_DAYS.default,
  ),
  /** The days a not-interested reply blocks a new enrollment, 1 or more. */
  CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS: whole(1, NOT_INTERESTED_COOL_DOWN_DAYS.default),
  /** The days after a not-now reply its reminder mails the owner, 1 or more. */
  CAMPAIGNS_NOT_NOW_REMINDER_DAYS: whole(1, NOT_NOW_REMINDER_DAYS.default),
  /** The days an out-of-office reply without a return date pauses, 1 or more. */
  CAMPAIGNS_OOO_DEFAULT_PAUSE_DAYS: whole(1, OOO_DEFAULT_PAUSE_DAYS.default),
  /** Business days after an out-of-office return date the campaign resumes, 0 (that day) or more. */
  CAMPAIGNS_OOO_RESUME_BUSINESS_DAYS: whole(0, OOO_RESUME_BUSINESS_DAYS.default),
});

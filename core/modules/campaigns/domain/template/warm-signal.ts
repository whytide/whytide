// The warm-signal template (README.md "The warm-signal default"; F08 §4.2, the profile visit left
// out), the steps a campaign made without steps starts from (../campaigns/commands.ts
// createCampaign): LinkedIn first, a connection request without a note and three messages, then the
// email fallback, three emails marked with the condition, the first due FALLBACK_AFTER_DAYS
// calendar days after the connection request went out and each skipped the moment it is accepted
// (../fallback/). The keys come at save, by action and order: connect, message_1, follow_up_1,
// follow_up_2, email_1, email_2, email_3. The seeded campaign keeps beta's template (constants.ts).
import { FALLBACK_CONDITION, FALLBACK_DELAY } from "../campaigns/constants.ts";
import {
  FALLBACK_EMAIL_2_BUSINESS_DAYS,
  FALLBACK_EMAIL_3_BUSINESS_DAYS,
  FIRST_MESSAGE_DELAY_HOURS,
  FOLLOW_UP_1_BUSINESS_DAYS,
  MIN_MINUTES_AFTER_ACCEPTANCE,
  WARM_FOLLOW_UP_2_BUSINESS_DAYS,
} from "./constants.ts";

const after = (value: number) => ({ anchor: "prev_step", unit: "business_days", value }) as const;

export const WARM_SIGNAL_STEPS = [
  { action: "invite", delay: { anchor: "enrollment" } },
  {
    action: "message",
    delay: {
      anchor: "accepted",
      unit: "hours",
      min: FIRST_MESSAGE_DELAY_HOURS.min,
      max: FIRST_MESSAGE_DELAY_HOURS.max,
      minMinutes: MIN_MINUTES_AFTER_ACCEPTANCE,
    },
  },
  { action: "message", delay: after(FOLLOW_UP_1_BUSINESS_DAYS) },
  { action: "message", delay: after(WARM_FOLLOW_UP_2_BUSINESS_DAYS) },
  { action: "email", delay: FALLBACK_DELAY, condition: FALLBACK_CONDITION },
  { action: "email", delay: after(FALLBACK_EMAIL_2_BUSINESS_DAYS), condition: FALLBACK_CONDITION },
  { action: "email", delay: after(FALLBACK_EMAIL_3_BUSINESS_DAYS), condition: FALLBACK_CONDITION },
] as const;

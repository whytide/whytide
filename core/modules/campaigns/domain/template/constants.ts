// The one fixed sequence of beta (README.md "The template"; F08 §4.2 "LinkedIn only", reduced to a
// connection request and messages, RB-9.1.2), beside the code that reads it: keys.ts, the enrollment
// and the later tasks' timing. The hash covers each step's key, action, delay and channel, so a
// changed delay or action makes new keys: a new TEMPLATE_VERSION.

/** The template's id stands where a campaign's will (RB-9.3.3). */
export const TEMPLATE_ID = "linkedin_default";
export const TEMPLATE_VERSION = 1;

/** The first message: a draw in these hours after the acceptance is detected (RB-11.2.4)… */
export const FIRST_MESSAGE_DELAY_HOURS = { min: 1, max: 3 } as const;
/** …and never within this many minutes of it (RB-11.2.4). */
export const MIN_MINUTES_AFTER_ACCEPTANCE = 10;

/**
 * The follow-ups: business days after the previous message was sent, Monday to Friday in the sender's
 * time zone, with no holiday calendar.
 */
export const FOLLOW_UP_1_BUSINESS_DAYS = 3;
export const FOLLOW_UP_2_BUSINESS_DAYS = 5;

/** The template's one channel. */
export const CHANNEL = "linkedin";

/** What joins the idempotency key's parts (not in the sources): no id, code or hex holds it. */
export const KEY_SEPARATOR = ":";

/** When a step falls due (the data model's delay: an anchor, a value and its unit). */
export type StepDelay =
  /** Due as the enrollment is made. */
  | { readonly anchor: "enrollment" }
  /** A draw from `min` to `max` hours after the acceptance is detected, never under `minMinutes`. */
  | {
      readonly anchor: "accepted";
      readonly unit: "hours";
      readonly min: number;
      readonly max: number;
      readonly minMinutes: number;
    }
  /** `value` business days after the previous step was sent. */
  | { readonly anchor: "prev_step"; readonly unit: "business_days"; readonly value: number };

/** A step of the template; `action` is the step's action_type. */
export type TemplateStep = {
  readonly stepKey: string;
  readonly position: number;
  readonly action: "invite" | "message";
  readonly channel: typeof CHANNEL;
  readonly delay: StepDelay;
};

/**
 * The four steps, by position. The connection request carries no note by default: its draft is
 * messaging's, empty unless the member writes one.
 */
export const TEMPLATE_STEPS = [
  {
    stepKey: "connect",
    position: 1,
    action: "invite",
    channel: CHANNEL,
    delay: { anchor: "enrollment" },
  },
  {
    stepKey: "message_1",
    position: 2,
    action: "message",
    channel: CHANNEL,
    delay: {
      anchor: "accepted",
      unit: "hours",
      min: FIRST_MESSAGE_DELAY_HOURS.min,
      max: FIRST_MESSAGE_DELAY_HOURS.max,
      minMinutes: MIN_MINUTES_AFTER_ACCEPTANCE,
    },
  },
  {
    stepKey: "follow_up_1",
    position: 3,
    action: "message",
    channel: CHANNEL,
    delay: { anchor: "prev_step", unit: "business_days", value: FOLLOW_UP_1_BUSINESS_DAYS },
  },
  {
    stepKey: "follow_up_2",
    position: 4,
    action: "message",
    channel: CHANNEL,
    delay: { anchor: "prev_step", unit: "business_days", value: FOLLOW_UP_2_BUSINESS_DAYS },
  },
] as const satisfies readonly TemplateStep[];

export type StepKey = (typeof TEMPLATE_STEPS)[number]["stepKey"];

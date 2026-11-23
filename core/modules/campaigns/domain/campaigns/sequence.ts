// A sequence's rules and its keys (README.md "Campaigns and versions"; F08 §5.2, RB-9.1.4), pure.
// validateSequence refuses a sequence off one of SEQUENCE_RULES, checked in that order, as 400
// campaign_sequence_invalid with details.rule: one to MAX_STEPS steps, each an invite, a message or
// an email; the first the connection request, due at the enrollment, and the only one (a sequence
// starts on LinkedIn, since an enrollment needs a sender account); at most three LinkedIn messages
// and three emails; a LinkedIn message, if any, second, with beta's draw after the acceptance;
// every other later step MIN_STEP_DELAY_BUSINESS_DAYS to CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS
// (settings.ts) business days after the step before it; the condition (gamma-p3-060, the fallback
// rule) only on emails, every email then carrying it as the last steps, the first of them
// FALLBACK_DELAY after the invitation and the others as above. keyedSteps gives each step its key
// by action and order, its position, channel and hash (beta's stepTemplateHash, unchanged), so a
// step unchanged across versions keeps its hash and its key; a condition enters the hash only when
// set.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../../errors.ts";
import { settings } from "../../settings.ts";
import type { StepDelay } from "../template/constants.ts";
import { canonicalJson, stepTemplateHash } from "../template/keys.ts";
import {
  ACTION_CHANNELS,
  FALLBACK_CONDITION,
  FALLBACK_DELAY,
  FIRST_MESSAGE_DELAY,
  MAX_STEPS,
  MIN_STEP_DELAY_BUSINESS_DAYS,
  SEQUENCE_ACTIONS,
  type SequenceAction,
  type SequenceRule,
  STEP_CONDITIONS,
  STEP_KEYS,
  type StepChannel,
  type StepCondition,
} from "./constants.ts";

/** A step as a sequence is given, in order: its action, its delay and its condition, unchecked. */
export type SequenceInput = {
  readonly action: string;
  readonly delay: unknown;
  readonly condition?: unknown;
};
/** A step of a sequence that passed the rules; `condition` only when it has one. */
export type SequenceStep = {
  readonly action: SequenceAction;
  readonly delay: StepDelay;
  readonly condition?: StepCondition;
};
/** A version's step, as saved and read; `condition` only when it has one. */
export type VersionStep = {
  readonly stepKey: string;
  readonly position: number;
  readonly action: SequenceAction;
  readonly channel: StepChannel;
  readonly delay: StepDelay;
  readonly condition?: StepCondition;
  readonly stepTemplateHash: string;
};
/** A step as the rules read it. */
type Parsed = {
  readonly action: SequenceAction;
  readonly delay: StepDelay | null;
  readonly condition: unknown;
};

/** The template's StepDelay, nothing more; the campaign route answers it too (schemas/campaigns.ts). */
export const stepDelay = z.discriminatedUnion("anchor", [
  z.strictObject({ anchor: z.literal("enrollment") }),
  z.strictObject({
    anchor: z.literal("accepted"),
    unit: z.literal("hours"),
    min: z.number(),
    max: z.number(),
    minMinutes: z.number(),
  }),
  z.strictObject({
    anchor: z.literal("prev_step"),
    unit: z.literal("business_days"),
    value: z.int(),
  }),
  z.strictObject({ anchor: z.literal("invite_sent"), unit: z.literal("days"), value: z.int() }),
]);

/** The value as a StepDelay; null for anything else. */
export function parseDelay(value: unknown): StepDelay | null {
  const parsed = stepDelay.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The sequence's steps when it passes every rule (the file's header); else the first it breaks. */
export function validateSequence(steps: readonly SequenceInput[]): SequenceStep[] {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    refuse("step_count");
  }
  const parsed = steps.map((step) => ({
    action: step?.action,
    delay: parseDelay(step?.delay),
    condition: step?.condition ?? null,
  }));
  if (!parsed.every((step) => isSequenceAction(step.action))) refuse("step_action");
  const [first, ...later] = parsed as Parsed[];
  if (first?.action !== "invite" || first.delay?.anchor !== "enrollment") refuse("connect_first");
  if (later.some(({ action }) => action === "invite")) refuse("connect_once");
  const count = (action: SequenceAction) => later.filter((step) => step.action === action).length;
  if (count("message") > STEP_KEYS.message.length || count("email") > STEP_KEYS.email.length) {
    refuse("channel_limit");
  }
  const firstMessage = later.findIndex(({ action }) => action === "message");
  const draw = later[0]?.delay;
  if (firstMessage > 0 || (firstMessage === 0 && !sameDelay(draw, FIRST_MESSAGE_DELAY))) {
    refuse("first_message");
  }
  // The fallback's first step is the fallback rule's to check: its delay counts from the
  // invitation.
  const fallback = (parsed as Parsed[]).findIndex(({ condition }) => condition !== null);
  const timed = (firstMessage === 0 ? later.slice(1) : later).filter(
    (step) => step !== parsed[fallback],
  );
  if (!timed.every(({ delay }) => isStepDelay(delay))) refuse("step_delay");
  if (fallback !== -1 && !isFallback(parsed as Parsed[], fallback)) refuse("fallback");
  return (parsed as Parsed[]).map(({ action, delay, condition }) =>
    condition === null
      ? { action, delay: delay as StepDelay }
      : { action, delay: delay as StepDelay, condition: condition as StepCondition },
  );
}

/**
 * The fallback rule, from its first marked step: a known condition, on emails only, in a sequence
 * with a connection request; every email marked, as the last steps; the first FALLBACK_DELAY after
 * the invitation, fixed (the others' delays are step_delay's).
 */
function isFallback(steps: readonly Parsed[], start: number): boolean {
  const marked = steps.slice(start);
  const conditions: readonly unknown[] = STEP_CONDITIONS;
  return (
    steps[0]?.action === "invite" &&
    marked.every(({ action, condition }) => action === "email" && conditions.includes(condition)) &&
    steps.slice(0, start).every(({ action }) => action !== "email") &&
    marked[0]?.condition === FALLBACK_CONDITION &&
    sameDelay(marked[0].delay, FALLBACK_DELAY)
  );
}

/** The steps with their keys by action and order, positions from 1, channels and hashes. */
export function keyedSteps(steps: readonly SequenceStep[]): VersionStep[] {
  const used: Record<SequenceAction, number> = { invite: 0, message: 0, email: 0 };
  return steps.map(({ action, delay, condition }, index) => {
    const stepKey = STEP_KEYS[action][used[action]++];
    if (stepKey === undefined) throw new Error(`keyedSteps: more ${action} steps than keys`);
    const channel = ACTION_CHANNELS[action];
    const hash = stepTemplateHash({ stepKey, action, delay, channel, condition });
    const step = { stepKey, position: index + 1, action, channel, delay };
    return condition === undefined
      ? { ...step, stepTemplateHash: hash }
      : { ...step, condition, stepTemplateHash: hash };
  });
}

/** Whether two versions' steps are the same: the same keys, actions and hashes, in order. */
export function sameSteps(a: readonly VersionStep[], b: readonly VersionStep[]): boolean {
  return (
    a.length === b.length &&
    a.every((step, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        step.stepKey === other.stepKey &&
        step.action === other.action &&
        step.stepTemplateHash === other.stepTemplateHash
      );
    })
  );
}

const isSequenceAction = (action: unknown): action is SequenceAction =>
  (SEQUENCE_ACTIONS as readonly unknown[]).includes(action);

const sameDelay = (delay: StepDelay | null | undefined, expected: StepDelay): boolean =>
  delay != null && canonicalJson(delay) === canonicalJson(expected);

/** A later step's delay: business days after the step before it, within the bounds configured. */
const isStepDelay = (delay: StepDelay | null): boolean =>
  delay?.anchor === "prev_step" &&
  delay.value >= MIN_STEP_DELAY_BUSINESS_DAYS &&
  delay.value <= settings.CAMPAIGNS_MAX_STEP_DELAY_BUSINESS_DAYS;

function refuse(rule: SequenceRule): never {
  throw new AppError(errors.campaign_sequence_invalid, { details: { rule } });
}

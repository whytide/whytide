// The kind a draft's text is written as (README.md "The writer"; gamma-p3-070): a step's from its
// step key, a lead's as it was asked, a lead's email without one a first email; and which kinds fit
// which channel. Pure.
import type { Channel } from "../../schemas/writer.ts";
import {
  EMAIL_STEP_KINDS,
  STEP_KINDS,
  type StepKey,
  WRITTEN_STEP_KINDS,
  type WrittenStepKind,
} from "./constants.ts";

const isStepKey = (value: string | null): value is StepKey =>
  value !== null && Object.hasOwn(STEP_KINDS, value);

/** An email's kinds for an email, a message's for a LinkedIn message; none for a note. */
export function kindFits(kind: WrittenStepKind, channel: Channel): boolean {
  const email = (EMAIL_STEP_KINDS as readonly string[]).includes(kind);
  return channel === "email" ? email : channel === "linkedin_message" && !email;
}

/** The draft's written kind; null for a note, a lead's message asked without one, or an odd key. */
export function writtenKindOf(draft: {
  readonly kind: string;
  readonly channel: Channel;
  readonly stepKey: string | null;
  readonly stepKind: string | null;
}): WrittenStepKind | null {
  const step = draft.kind === "outbound_step";
  const { stepKey } = draft;
  const asked = step ? (isStepKey(stepKey) ? STEP_KINDS[stepKey] : null) : draft.stepKind;
  const kind = WRITTEN_STEP_KINDS.find((written) => written === asked);
  if (kind !== undefined || step) return kind ?? null;
  return draft.channel === "email" ? "email_first" : null;
}

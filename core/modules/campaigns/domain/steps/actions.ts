// Which steps wait for their sender account's owner (constants.ts). It fails closed: every action
// needs an approved item before it goes, but those exempted by name, a withdrawal, which sends
// nothing to the person. An action added later is blocked by the gate (not_approved) until it is
// exempted here or approvals' items hold it. The queue opens items for APPROVED_ACTIONS only.
// gamma-p4-070: whose approval a step needs in its campaign's mode (approvalRequired), and which steps
// are first touches (isFirstTouch), both failing closed to a person's. review-gaps: a follow-up is a
// first touch until a message of its action went out from its enrollment.
// Then the one narrowing of a LinkedIn step (gamma-p3-030): its sender account, which the CHECK
// step_executions_channel_actor sets on every LinkedIn step, and its action; an email step that
// reaches LinkedIn's code is a bug in a filter, and fails loudly.
import {
  type ApprovalRequirement,
  PERSON_OR_MODE,
  REVIEW_FIRST_TOUCHES,
} from "../approval-mode/constants.ts";
import { LINKEDIN_ACTIONS, type LinkedInAction } from "../constants.ts";
import {
  APPROVAL_EXEMPT_ACTIONS,
  APPROVED_ACTIONS,
  type ApprovedAction,
  MODE_ACTIONS,
  SENT_STEP_STATUS,
} from "./constants.ts";

/** A step of the enrollment as the first-touch rule reads it: its id, its action and its status. */
export type EnrolledStep = {
  readonly id: string;
  readonly actionType: string;
  readonly status: string;
};

/** Whether a step of the action needs an approved item before it goes: all but a withdrawal. */
export const needsApproval = (action: string): boolean =>
  !(APPROVAL_EXEMPT_ACTIONS as readonly string[]).includes(action);

/** Whether the queue opens an item for a step of the action: a connection request or a message. */
export const opensItem = (action: string): action is ApprovedAction =>
  (APPROVED_ACTIONS as readonly string[]).includes(action);

/**
 * Whose approval a step needs in its campaign's effective mode (README.md "The approval mode"):
 * none for a withdrawal; a person's for every step in review_everything and for a first touch in
 * review_first_touches; a person's or the mode's for a follow-up there, a message's or an email's;
 * a person's for any other action or mode, one added later included.
 */
export function approvalRequired(
  step: { readonly actionType: string; readonly firstTouch: boolean },
  mode: string,
): ApprovalRequirement {
  if (!needsApproval(step.actionType)) return "none";
  const byMode = (MODE_ACTIONS as readonly string[]).includes(step.actionType);
  if (mode === REVIEW_FIRST_TOUCHES && step.firstTouch === false && byMode) return PERSON_OR_MODE;
  return "person";
}

/**
 * Whether the step is a first touch (not in the sources; review-gaps): the first message of its
 * action the person receives from the enrollment. A step is a follow-up only when both hold: an
 * earlier step of its version has its action (by position, so the connection request, the first
 * LinkedIn message and the first email are first touches always), and another step of its action in
 * its enrollment has `succeeded` (`enrolled`, the enrollment's steps). Anything else is a first
 * touch: a key the version lacks or holds with another action, no version (an empty list), no
 * enrollment (null), or an enrollment that does not hold the step. It fails closed.
 */
export function isFirstTouch(
  step: { readonly id: string; readonly stepKey: string; readonly actionType: string },
  steps: readonly {
    readonly stepKey: string;
    readonly action: string;
    readonly position: number;
  }[] = [],
  enrolled: readonly EnrolledStep[] | null = null,
): boolean {
  const own = steps.find(({ stepKey }) => stepKey === step.stepKey);
  if (own === undefined || own.action !== step.actionType) return true;
  const earlier = steps.some(
    ({ action, position }) => action === own.action && position < own.position,
  );
  if (!earlier || enrolled === null || !enrolled.some(({ id }) => id === step.id)) return true;
  return !enrolled.some(
    ({ id, actionType, status }) =>
      id !== step.id && actionType === own.action && status === SENT_STEP_STATUS,
  );
}

/** The LinkedIn step's sender account; none, an email step's, throws. */
export function linkedinSenderAccount(step: {
  readonly id: string;
  readonly senderAccountId: string | null;
}): string {
  if (step.senderAccountId === null) throw new Error(`${step.id}: no sender account on the step`);
  return step.senderAccountId;
}

/** A where's filter on LinkedIn's actions, which the plan's and the sender's reads name. */
export const linkedinOnly = (): { actionType: { in: LinkedInAction[] } } => ({
  actionType: { in: [...LINKEDIN_ACTIONS] },
});

/** Whether the action is one of LinkedIn's: not email. */
export const isLinkedInAction = (action: string): action is LinkedInAction =>
  (LINKEDIN_ACTIONS as readonly string[]).includes(action);

/** The LinkedIn step's action; email, or any other, throws. */
export function linkedinActionType(step: {
  readonly id: string;
  readonly actionType: string;
}): LinkedInAction {
  const { actionType } = step;
  if (!isLinkedInAction(actionType)) {
    throw new Error(`${step.id}: ${actionType} is no LinkedIn action`);
  }
  return actionType;
}

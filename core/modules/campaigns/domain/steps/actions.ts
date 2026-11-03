// Which steps wait for their sender account's owner (constants.ts). It fails closed: every action
// needs an approved item before it goes, but those exempted by name, a withdrawal, which sends
// nothing to the person. An action added later is blocked by the gate (not_approved) until it is
// exempted here or approvals' items hold it. The queue opens items for APPROVED_ACTIONS only.
import { APPROVAL_EXEMPT_ACTIONS, APPROVED_ACTIONS, type ApprovedAction } from "./constants.ts";

/** Whether a step of the action needs an approved item before it goes: all but a withdrawal. */
export const needsApproval = (action: string): boolean =>
  !(APPROVAL_EXEMPT_ACTIONS as readonly string[]).includes(action);

/** Whether the queue opens an item for a step of the action: a connection request or a message. */
export const opensItem = (action: string): action is ApprovedAction =>
  (APPROVED_ACTIONS as readonly string[]).includes(action);

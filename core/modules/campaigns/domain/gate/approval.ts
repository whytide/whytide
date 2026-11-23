// The gate's approval check (README.md "The approval check"; docs/flows.md "The gate"), last in its
// order, for every step but a withdrawal (steps/actions.ts, failing closed): nothing reaches a
// person without its sender account's owner's approval of exactly that text (beta's rules we keep),
// or, for a follow-up in a campaign whose effective mode is review_first_touches at the check, the
// mode's approval of that text with its AI disclosure line (gamma-p4-070); review-gaps: a follow-up
// whose enrollment has sent no message of its action is a first touch, so a mode's approval of it, an
// item opened for the mode before that rule included, is not_approved. The step's item must be
// the step's approved item in approvals' decisionsFor, else not_approved; a mode's approval under any
// other requirement is not_approved too; approvals' approvedContent, asked for the mode's only when
// the step may take it, must answer for that item, its frozen text still hashing to the approval's
// hash, else content_changed. All is read in the caller's run with no cache, so a block, a cancel or
// a change of the mode committed a moment before is seen. The gate writes the block; a pass gives the
// item, the hash, the mode, the first touch and the approval's origin, which the sender stores with
// its send and the report reads.
import { approvedContent, decisionsFor } from "@whytide/approvals";
import { type ApprovalMode, MODE_ORIGIN, PERSON_OR_MODE } from "../approval-mode/constants.ts";
import { type RequirementStep, stepRequirement } from "../approval-mode/requirement.ts";

/**
 * What the check saw: the step's item, that item's status when it is the step's latest in approvals,
 * and the approved text's hash on a pass, with the campaign's effective mode, whether the step is a
 * first touch and the approval's origin (gamma-p4-070). Ids, a status, a hash and codes: never a text.
 */
export type ApprovalSeen = {
  readonly approvalItemId: string | null;
  readonly status: string | null;
  readonly contentHash: string | null;
  readonly mode?: ApprovalMode;
  readonly firstTouch?: boolean;
  readonly origin?: "app" | typeof MODE_ORIGIN;
};
export type ApprovalCheck =
  | { readonly pass: true; readonly seen: ApprovalSeen }
  | {
      readonly pass: false;
      readonly reason: "not_approved" | "content_changed";
      readonly seen: ApprovalSeen;
    };

/** The check on the step as the gate read it, at the gate's instant (the file's header). */
export async function checkApproval(
  step: RequirementStep & { readonly id: string; readonly approvalItemId: string | null },
  at: Date,
): Promise<ApprovalCheck> {
  const { approvalItemId } = step;
  const [latest] = await decisionsFor([step.id]);
  const status = latest?.approvalItemId === approvalItemId ? latest.status : null;
  const seen: ApprovalSeen = { approvalItemId, status, contentHash: null };
  if (approvalItemId === null || status !== "approved") {
    return { pass: false, reason: "not_approved", seen };
  }
  const { mode, firstTouch, required } = await stepRequirement(step, at);
  const allowMode = required === PERSON_OR_MODE;
  // The mode's approval is no approval where a person's is needed.
  if (latest?.decisionOrigin === MODE_ORIGIN && !allowMode) {
    return { pass: false, reason: "not_approved", seen };
  }
  const content = await approvedContent(step.id, { allowMode });
  if (content === null || content.approvalItemId !== approvalItemId) {
    return { pass: false, reason: "content_changed", seen };
  }
  const { contentHash, origin } = content;
  return { pass: true, seen: { ...seen, contentHash, mode, firstTouch, origin } };
}

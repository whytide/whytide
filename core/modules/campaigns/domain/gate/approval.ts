// The gate's approval check (README.md "The approval check"; docs/flows.md "The gate"), last in its
// order, for every step but a withdrawal (steps/actions.ts, failing closed): nothing reaches a
// person without its sender account's owner's approval of exactly that text (beta's rules we keep).
// The step's item must be the step's approved item in approvals' decisionsFor, else not_approved;
// approvals' approvedContent must answer for that item, its frozen text still hashing to the
// approval's hash, else content_changed. Both are read in the caller's run with no cache, so a
// block or a cancel committed a moment before is seen. The gate writes the block; a pass gives the
// item and the hash, which the sender stores with its send.
import { approvedContent, decisionsFor } from "@whytide/approvals";

/**
 * What the check saw: the step's item, that item's status when it is the step's latest in approvals,
 * and the approved text's hash on a pass. Ids, a status and a hash: never a text.
 */
export type ApprovalSeen = {
  readonly approvalItemId: string | null;
  readonly status: string | null;
  readonly contentHash: string | null;
};
export type ApprovalCheck =
  | { readonly pass: true; readonly seen: ApprovalSeen }
  | {
      readonly pass: false;
      readonly reason: "not_approved" | "content_changed";
      readonly seen: ApprovalSeen;
    };

/** The check on the step as the gate read it (the file's header). */
export async function checkApproval(step: {
  readonly id: string;
  readonly approvalItemId: string | null;
}): Promise<ApprovalCheck> {
  const { approvalItemId } = step;
  const [latest] = await decisionsFor([step.id]);
  const status = latest?.approvalItemId === approvalItemId ? latest.status : null;
  const seen: ApprovalSeen = { approvalItemId, status, contentHash: null };
  if (approvalItemId === null || status !== "approved") {
    return { pass: false, reason: "not_approved", seen };
  }
  const content = await approvedContent(step.id);
  if (content === null || content.approvalItemId !== approvalItemId) {
    return { pass: false, reason: "content_changed", seen };
  }
  return { pass: true, seen: { ...seen, contentHash: content.contentHash } };
}

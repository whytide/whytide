// drafts_small_edits (README.md "Commands"; beta's "Done when": at least half of the drafts approved
// with no or small edits), in the caller's tenant run: approvals' editStats of the items approved in
// the period, which leaves out an invite approved with an empty note and counts an edit ratio up to
// approvals' APPROVALS_SMALL_EDIT_MAX_RATIO (0.2 unset) as small. The command adds the workspaces' counts, never one query across them. gamma-p7-050:
// unedited_approvals (gamma's "Done when": at least half approved without an edit), from the same
// counts; editStats leaves out the mode's approvals, so the follow-ups "Review first touches"
// approved are not in it.
import { type EditStats, editStats } from "@whytide/approvals";

/** The workspace's approvals of the period: approved, unedited, with a small edit. */
export const editCounts = (period: { readonly since: Date }): Promise<EditStats> =>
  editStats({ since: period.since });

/** (unedited + small edits) / approved; null when nothing was approved. */
export function editShare({ approved, unedited, smallEdits }: EditStats): number | null {
  return approved === 0 ? null : (unedited + smallEdits) / approved;
}

/** unedited / approved; null when nothing was approved. */
export function uneditedShare({ approved, unedited }: EditStats): number | null {
  return approved === 0 ? null : unedited / approved;
}

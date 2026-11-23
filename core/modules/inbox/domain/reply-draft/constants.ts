// The reply draft's values (README.md "The reply draft"; inbox-reply-draft), beside their readers:
// plain values, which the screen imports too.

/** The member's brief, trimmed, at most: messaging's writer takes as much (its REPLY_BRIEF_MAX). */
export const REPLY_BRIEF_MAX = 2_000;
/** The brief as the route takes it, before the trim: REPLY_BRIEF_MAX is checked after it. */
export const REPLY_BRIEF_BODY_MAX = 8_000;
/** A draft's state, as the table's enum; `none` is a thread without one, the read's alone. */
export const REPLY_DRAFT_STATUSES = ["drafting", "ready", "failed"] as const;
export type ReplyDraftStatus = (typeof REPLY_DRAFT_STATUSES)[number];
/** inbox_draft_reply's id is `<REPLY_DRAFT_WORKFLOW>:<workspaceId>:<draftId>`: one run per draft. */
export const REPLY_DRAFT_WORKFLOW = "inbox.reply_draft";
/** A draft still drafting this long after its request has no run left: the sweep fails it. */
export const REPLY_DRAFT_STUCK_MINUTES = 30;
export const MS_PER_MINUTE = 60_000;
/** The failure codes of the run's own: past its attempts without a code, and the sweep's. */
export const WRITE_FAILED = "write_failed";
export const DRAFT_STUCK = "draft_stuck";
/** A code as a failure carries it: a registered code's shape, never a text. */
export const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

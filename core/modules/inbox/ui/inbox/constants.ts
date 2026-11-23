// The inbox's screens' tunable values, beside the code that reads them (docs/rules/coding.md
// "constants").
import type { MessageResponse } from "../../schemas/threads.ts";

/** The threads a read of the list asks for, "Load more" the next as many (the api's: 50 at most). */
export const PAGE_SIZE = 20;

/** The loading state's rows: as many as fill the first screen. */
export const LOADING_ROWS = 6;

/** The loading state's shimmering lines of the thread: a message's card each. */
export const LOADING_LINES = [3, 2, 3] as const;

/** A message's time, and the time the list shows: the day and the minute, in the reader's zone. */
export const TIME_FORMAT = { dateStyle: "medium", timeStyle: "short" } as const;

/** While a reply from the inbox is sending, the thread is read again this often. */
export const SENDING_POLL_MS = 3000;

/** At most this many reads again while a reply is sending (two minutes); a reload reads on. */
export const SENDING_POLL_MAX = 40;

/** The reply box's lines. */
export const REPLY_ROWS = 4;

/** The words a Not sent reply shows (reply-status.tsx), each its message key there. */
export type ReplyReason = "suppressed" | "unavailable" | "hours" | "day_used" | "refused" | "other";

/**
 * The codes a Not sent reply shows in a reply's own words, not their module's: the owner decided a
 * reply refused is not kept for later (README.md "Replies from the inbox"), while linkedin's words
 * for the hours and the day's limits say a send waits; contacts' suppression and the channel gone
 * in inbox's words; linkedin's refusal of the message; and, as any other, the codes whose words say
 * a send waits or name its slot. Any code not here shows inbox's words, else linkedin's.
 */
export const REPLY_REASONS: Readonly<Record<string, ReplyReason>> = {
  person_suppressed: "suppressed",
  linkedin_account_disconnected: "unavailable",
  linkedin_not_found: "unavailable",
  outside_working_hours: "hours",
  message_cap_reached: "day_used",
  daily_actions_cap_reached: "day_used",
  read_cap_reached: "day_used",
  linkedin_limit_reached: "day_used",
  linkedin_send_refused: "refused",
  member_id_unknown: "other",
  send_attempt_late: "other",
  reservation_not_open: "other",
};

/** The reply draft's route (reply-draft.tsx). */
export const REPLY_DRAFT_PATH = "/v1/workspaces/{workspaceId}/inbox/threads/{id}/reply-draft";
/** While a reply draft is drafting, it is read again this often, for ten minutes at most. */
export const DRAFT_POLL_MS = 2000;
export const DRAFT_TIMEOUT_MS = 10 * 60_000;
/** The brief's lines. */
export const BRIEF_ROWS = 3;

/** The words a failed reply draft shows (reply-draft.tsx), each its `inbox.draft.failure` key. */
export type DraftFailure = "checks" | "lead" | "stuck" | "other";
/**
 * A failed draft's code in words: the writer's answers refused, the lead or the conversation not
 * readable, a run that stopped; any other code, a provider's among them, the generic words.
 */
export const DRAFT_FAILURES: Readonly<Record<string, DraftFailure>> = {
  ai_failed: "checks",
  gates_failed: "checks",
  dossier_lead_not_found: "lead",
  conversation_empty: "lead",
  draft_stuck: "stuck",
  write_failed: "stuck",
};

/**
 * A reply's label's badge colour (label-buttons.tsx, gamma-p4-040): interested good, an opt-out gone
 * wrong, a pause or a bounce to mind, out of office the accent, the rest neutral.
 */
export const CLASS_TONES = {
  interested: "success",
  not_now: "warning",
  not_interested: "neutral",
  out_of_office: "accent",
  opt_out: "danger",
  bounce: "warning",
  other: "neutral",
} as const satisfies Record<NonNullable<MessageResponse["classification"]>["label"], string>;
export type ClassLabel = keyof typeof CLASS_TONES;

/**
 * The 7 labels the label's menu offers (label-buttons.tsx, gamma-p4-055), in campaigns' order:
 * CLASS_TONES' keys, which its type holds complete. The screen cannot import campaigns.
 */
export const CLASS_LABELS = Object.keys(CLASS_TONES) as ClassLabel[];

/** The label that suppresses the person for good: choosing it asks first. */
export const OPT_OUT_CLASS: ClassLabel = "opt_out";

/** The label's route (label-buttons.tsx). */
export const LABEL_PATH = "/v1/workspaces/{workspaceId}/inbox/messages/{id}/label";

/**
 * linkedin's accounts route, which says whether the member has a sender of their own (page.tsx), and
 * its screen, where they connect one: the list's empty state without a sender (gamma-p6-060).
 */
export const ACCOUNTS_PATH = "/v1/workspaces/{workspaceId}/linkedin/accounts";
export const LINKEDIN_SCREEN = "linkedin";

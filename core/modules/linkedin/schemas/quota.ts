// The inputs of the quota's reservations, reads and sends, and of the action log (README.md "Read
// quota"), which code calls, the log's closed list of outcomes, and the usage route's answer, the
// day's budgets, from which the api host builds the OpenAPI document.
import { z } from "zod";
import { SEND_KEY_MAX_CHARS } from "../domain/send/constants.ts";

const LINKEDIN_HOSTS = new Set(["linkedin.com", "www.linkedin.com"]);
/** A person's id (contacts'). */
export const PERSON_ID = /^per_[0-9A-HJKMNP-TV-Z]{26}$/;
/** A step execution's id (campaigns'), what a send's log row names. */
export const STEP_EXECUTION_ID = /^sx_[0-9A-HJKMNP-TV-Z]{26}$/;
const COLON = "(?::|%3[Aa])";
const POST_PATH = new RegExp(
  `^/(?:posts/[\\w%.~-]+|feed/update/urn${COLON}li${COLON}(?:activity|share|ugcPost)${COLON}\\d{1,30})/?$`,
);

/**
 * A person's id (`per_…`), a step execution's (`sx_…`) or a LinkedIn post's URL, https, with no
 * query or fragment: never a profile's URL, which names a person who may not be a person of ours
 * (docs/security.md).
 */
export function isObjectRef(value: string): boolean {
  if (PERSON_ID.test(value) || STEP_EXECUTION_ID.test(value)) return true;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  const plain = url.protocol === "https:" && !url.username && !url.port && !url.search && !url.hash;
  return plain && LINKEDIN_HOSTS.has(url.hostname) && POST_PATH.test(url.pathname);
}

const accountId = z.string().min(1).max(64);
const objectRef = z.string().max(2048).refine(isObjectRef);
/** What a send reserves: a connection request, a message or a withdrawal. */
export const sendActionTypes = ["invite", "message", "withdraw"] as const;
export type SendActionType = (typeof sendActionTypes)[number];
/**
 * The reads (`send_check`: the checks before a send's retry and before a message; `pending_invites`
 * and `relation_check`: the day's check of the pending invitations, beta-p4-070), the sends, the
 * status checks.
 */
export const actionKinds = [
  "read_engagers",
  "read_profile",
  "status_check",
  "invite",
  "message",
  "withdraw",
  "send_check",
  "pending_invites",
  "relation_check",
] as const;

/**
 * Every outcome an action-log row may record, the CHECK of linkedin_sending_disclosure (a test keeps
 * them equal): `ok`, `reserved`, every refusal of reserveSend and reserveReads, the later tasks' too,
 * `reservation_not_open`, every code of the LinkedIn port, and what a status check records: the
 * statuses, and sender_account_in_use.
 */
export const ACTION_OUTCOMES = [
  "ok",
  "reserved",
  "linkedin_account_disconnected",
  "rate_limited",
  "outside_working_hours",
  "invite_note_budget",
  "invite_cap_reached",
  "message_cap_reached",
  "withdrawal_cap_reached",
  "weekly_invite_cap_reached",
  "daily_actions_cap_reached",
  "read_cap_reached",
  "sending_closed",
  "platform_stopped",
  "workspace_stopped",
  "account_stopped",
  "account_paused",
  "invites_paused",
  "disclosure_required",
  "member_id_unknown",
  "pending_invites_over_limit",
  "pending_invites_unknown",
  "reservation_not_open",
  "linkedin_rate_limited",
  "linkedin_not_found",
  "linkedin_webhook_invalid",
  "linkedin_provider_error",
  "linkedin_limit_reached",
  "linkedin_send_refused",
  "linkedin_input_invalid",
  "linkedin_output_invalid",
  "linkedin_error_unmapped",
  "connected",
  "disconnected",
  "credentials_required",
  "error",
  "sender_account_in_use",
] as const;
export type ActionOutcome = (typeof ACTION_OUTCOMES)[number];
export const isActionOutcome = (value: string): value is ActionOutcome =>
  (ACTION_OUTCOMES as readonly string[]).includes(value);

export const reserveInput = z.strictObject({
  accountId,
  /**
   * Reads: an engager-list page counts one, a profile one, a check before a send one, a page of the
   * pending invitations one, a relation one.
   */
  count: z.int().min(1).max(1000),
  kind: z.enum([
    "read_engagers",
    "read_profile",
    "send_check",
    "pending_invites",
    "relation_check",
  ]),
  objectRef: objectRef.optional(),
});
export type ReserveInput = z.input<typeof reserveInput>;

/** A send's slot: the step's key as campaigns gives it (never built here); a note on an invite only. */
export const sendInput = z
  .strictObject({
    accountId,
    actionType: z.enum(sendActionTypes),
    idempotencyKey: z.string().min(1).max(SEND_KEY_MAX_CHARS),
    withNote: z.boolean().optional(),
  })
  .refine(({ actionType, withNote }) => !withNote || actionType === "invite", {
    path: ["withNote"],
  });
export type SendInput = z.input<typeof sendInput>;

const reservationId = z.string().min(1).max(64);
/** `actual`: the reads made, counted as made, above the reservation too. */
export const commitInput = z.strictObject({ reservationId, actual: z.int().min(0).max(1000) });
export const releaseInput = z.strictObject({ reservationId });

const SEND_KINDS: readonly string[] = sendActionTypes;
export const logInput = z
  .strictObject({
    accountId,
    kind: z.enum(actionKinds),
    objectRef: objectRef.optional(),
    count: z.int().min(0).max(1000),
    outcome: z.enum(ACTION_OUTCOMES),
    /** An invite carrying a note. */
    withNote: z.boolean().optional(),
    /** The call the row answers, the same on each of its attempts (health/signals.ts). */
    callRef: z.string().min(1).max(512).optional(),
  })
  .refine(({ kind, withNote }) => !withNote || kind === "invite", { path: ["withNote"] })
  // A send's row names its step execution, never a person or a post.
  .refine(
    ({ kind, objectRef }) =>
      objectRef === undefined || !SEND_KINDS.includes(kind) || STEP_EXECUTION_ID.test(objectRef),
    { path: ["objectRef"] },
  );
export type LogInput = z.input<typeof logInput>;

/** Reserved plus made today, against a limit. */
const used = z.int();

export const usageResponse = z.strictObject({
  /** The account's date now, in its time zone. */
  quotaDay: z.iso.date(),
  cap: z.int(),
  /** The highest cap the account may be given, LINKEDIN_DAILY_READ_CAP_MAX. */
  capMax: z.int(),
  reserved: z.int(),
  committed: z.int(),
  windowOpen: z.boolean(),
  /** The next start of the working hours after now. */
  nextWindowAt: z.iso.datetime(),
  /** The day's reads at most, drawn with its row; today's reads stop at the smaller of it and `cap`. */
  readAllowance: z.int(),
  /** Connection requests today against the day's limit. */
  invites: z.strictObject({ used, limit: z.int() }),
  messages: z.strictObject({ used, limit: z.int() }),
  /** Withdrawals today against their hard maximum. */
  withdrawals: z.strictObject({ used, max: z.int() }),
  /** Connection requests over the last seven quota days, today's included, against the weekly cap. */
  weekInvites: z.strictObject({ used, cap: z.int() }),
  /** Every action today, reads included, against the 200. */
  actions: z.strictObject({ used, max: z.int() }),
});
export type UsageResponse = z.infer<typeof usageResponse>;

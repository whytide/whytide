// The error map (docs/flows.md "The error map"): for every answer a send can get, what happens to
// its slot and to the account's retry_at (linkedin's, beta-p1-050), to its credits and its step
// (campaigns', beta-p4-020 and beta-p4-040), and to the account's health (beta-p6-010's). A frozen
// constant; sendAnswerOf finds an answer's row, a code the port does not have being an unmapped one.
import { ACCOUNT_COOLDOWN_MS, PROVIDER_ERROR_PAUSE_MS } from "./constants.ts";

export type SendEffect = {
  /** Committed, released, kept until linkedin_check_sent answers, or committed already. */
  readonly slot: "commit" | "release" | "keep_until_checked" | "already_committed";
  /** Committed, released, settled as the slot is, or settled as sent once the check says so. */
  readonly credits: "commit" | "release" | "as_slot" | "as_sent_after_check";
  readonly step: StepEffect;
  /** retry_at, set by linkedin; the health, set by beta-p6-010; null: nothing. */
  readonly account: AccountEffect | null;
};
export type StepEffect =
  | { readonly status: "succeeded" }
  /**
   * Run again later: not before now plus the answer's retryAfterSec, the refusal's retryAt (its
   * resume when null), or the account's resume; null, as the sender workflow plans it.
   */
  | {
      readonly status: "rescheduled";
      readonly notBefore: "retry_after" | "retry_at" | "resume" | null;
    }
  /** Failed for good: `exit`, the enrollment's exit reason; `defect`, a call off the port's schema. */
  | { readonly status: "failed"; readonly exit: "send_refused" | null; readonly defect: boolean }
  /**
   * Left executing and checked after the pause (linkedin_check_sent): went out, succeeded; did not,
   * rescheduled; never retried in a loop.
   */
  | { readonly status: "executing"; readonly checkAfterPauseMs: number };
export type AccountEffect =
  /** retry_at = now plus the answer's retryAfterSec. */
  | { readonly retryAt: "retry_after" }
  /** retry_at = now plus `pauseMs`; the sender ends its session. */
  | { readonly retryAt: "pause"; readonly pauseMs: number; readonly endSession: true }
  /** The account paused with this health for `forMs` (beta-p6-010). */
  | {
      readonly health: "restricted" | "checkpoint";
      readonly trigger: "limit_reached" | null;
      readonly forMs: number;
    }
  /** The account is disconnected: its user reconnects it. */
  | { readonly health: "disconnected" };

/** linkedin_provider_error, linkedin_output_invalid, linkedin_error_unmapped: did the send go out? */
const OUTCOME_UNKNOWN: SendEffect = {
  slot: "keep_until_checked",
  credits: "as_slot",
  step: { status: "executing", checkAfterPauseMs: PROVIDER_ERROR_PAUSE_MS },
  account: { retryAt: "pause", pauseMs: PROVIDER_ERROR_PAUSE_MS, endSession: true },
};
/** LinkedIn saw the call and refused it for good, or its person is gone: the slot counts. */
const SEND_REFUSED: SendEffect = {
  slot: "commit",
  credits: "release",
  step: { status: "failed", exit: "send_refused", defect: false },
  account: null,
};
const notSent = (account: AccountEffect | null): SendEffect => ({
  slot: "release",
  credits: "release",
  step: { status: "rescheduled", notBefore: null },
  account,
});

/** Every answer a send can get, by its key (sendAnswerOf), to what happens next. */
export const SEND_ERROR_MAP = frozen({
  success: {
    slot: "commit",
    credits: "commit",
    step: { status: "succeeded" },
    account: null,
  },
  linkedin_rate_limited: {
    slot: "release",
    credits: "release",
    step: { status: "rescheduled", notBefore: "retry_after" },
    account: { retryAt: "retry_after" },
  },
  linkedin_provider_error: OUTCOME_UNKNOWN,
  linkedin_output_invalid: OUTCOME_UNKNOWN,
  linkedin_error_unmapped: OUTCOME_UNKNOWN,
  // A webhook's code, which no send answers: unknown, as an unmapped one is.
  linkedin_webhook_invalid: OUTCOME_UNKNOWN,
  linkedin_send_refused: SEND_REFUSED,
  linkedin_not_found: SEND_REFUSED,
  linkedin_limit_reached: {
    slot: "commit",
    credits: "release",
    step: { status: "rescheduled", notBefore: "resume" },
    account: { health: "restricted", trigger: "limit_reached", forMs: ACCOUNT_COOLDOWN_MS },
  },
  "linkedin_account_disconnected:checkpoint": notSent({
    health: "checkpoint",
    trigger: null,
    forMs: ACCOUNT_COOLDOWN_MS,
  }),
  "linkedin_account_disconnected:restricted": notSent({
    health: "restricted",
    trigger: null,
    forMs: ACCOUNT_COOLDOWN_MS,
  }),
  /** Reason credentials_required, disconnected, or none. */
  linkedin_account_disconnected: notSent({ health: "disconnected" }),
  linkedin_input_invalid: {
    slot: "release",
    credits: "release",
    step: { status: "failed", exit: null, defect: true },
    account: null,
  },
  /** reserveSend's refusal, or the send activity's own just before the call. */
  refused_before_call: {
    slot: "release",
    credits: "release",
    step: { status: "rescheduled", notBefore: "retry_at" },
    account: null,
  },
  /** reserveSend answered a repeat of the key with a committed reservation: the send went out. */
  committed_repeat: {
    slot: "already_committed",
    credits: "as_sent_after_check",
    step: { status: "succeeded" },
    account: null,
  },
} satisfies Record<string, SendEffect>);
export type SendErrorMap = typeof SEND_ERROR_MAP;
export type SendAnswer = keyof SendErrorMap;

/**
 * The map's key for an answer: `success`, `refused_before_call`, `committed_repeat`, or the error's
 * code, linkedin_account_disconnected with its `details.reason` when that is `checkpoint` or
 * `restricted`; a code the map does not have is linkedin_error_unmapped's.
 */
export function sendAnswerOf(code: string, reason?: unknown): SendAnswer {
  if (code === "linkedin_account_disconnected") {
    if (reason === "checkpoint") return "linkedin_account_disconnected:checkpoint";
    if (reason === "restricted") return "linkedin_account_disconnected:restricted";
    return code;
  }
  return isSendAnswer(code) ? code : "linkedin_error_unmapped";
}

const isSendAnswer = (code: string): code is SendAnswer => Object.hasOwn(SEND_ERROR_MAP, code);

/** The table and every row and value in it, frozen, so nothing at run time changes them. */
function frozen<T extends object>(value: T): Readonly<T> {
  for (const inner of Object.values(value)) {
    if (typeof inner === "object" && inner !== null) frozen(inner);
  }
  return Object.freeze(value);
}

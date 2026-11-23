// What a reply's send came to (README.md "Replies from the inbox"; docs/flows.md "A reply from the
// inbox"), pure: linkedin's answer to the send or to its check, read as the error map left the slot.
// Sent; refused before the call or failed after it, its slot freed or counted; unknown while the slot
// is kept for linkedin_check_sent (keep_until_checked, or a check whose read was refused) or when the
// activity gave no answer. A check's "not sent" fails the reply with the send's own code: the member
// presses again, as a new reply; nothing sends twice.

/**
 * linkedin's answer to the send (SendResult) or to its check (CheckSentResult), as the workflow
 * passes it on: sent; checked; refused before the call, `retryAt` when to ask again; or the port's
 * error after it, `retryAfterSec` for a rate limit. Codes as strings: linkedin's ActionOutcome.
 */
export type Answer =
  | { readonly sent: true; readonly stepExecutionId: string }
  | { readonly outcome: "sent" | "not_sent"; readonly stepExecutionId: string }
  | { readonly refused: string; readonly retryAt: string | null }
  | { readonly refused: string; readonly retryAfterSec?: number | undefined };
export type Outcome =
  | { readonly kind: "sent" }
  | { readonly kind: "refused" | "failed"; readonly code: string | null }
  /** `retryAt`: a refused check's time to ask again, as linkedin gave it. */
  | { readonly kind: "unknown"; readonly code: string | null; readonly retryAt: string | null };

/**
 * The send's answer, null for none (the attempt failed); `held`, its slot still reserved after it.
 * A refusal's shape has `retryAt` (before the call), a failure's not (the port's error after it).
 */
export function sendOutcome(answer: Answer | null, held: boolean): Outcome {
  if (answer === null) return { kind: "unknown", code: null, retryAt: null };
  if ("sent" in answer) return { kind: "sent" };
  if ("outcome" in answer) return checkOutcome(answer, null);
  const retryAt = "retryAt" in answer ? answer.retryAt : null;
  if (held) return { kind: "unknown", code: answer.refused, retryAt };
  return { kind: "retryAt" in answer ? "refused" : "failed", code: answer.refused };
}

/** The chat's read before the send refused: the reply refused with the read's code, never sent. */
export function readOutcome(answer: Answer | null): Outcome {
  const code = answer !== null && "refused" in answer ? answer.refused : null;
  return { kind: "refused", code };
}

/** The check's answer, null for none; `code`, the send's, which a reply not sent fails with. */
export function checkOutcome(answer: Answer | null, code: string | null): Outcome {
  if (answer === null) return { kind: "unknown", code, retryAt: null };
  if ("sent" in answer) return { kind: "sent" };
  if ("outcome" in answer) {
    return answer.outcome === "sent" ? { kind: "sent" } : { kind: "failed", code };
  }
  return { kind: "unknown", code, retryAt: "retryAt" in answer ? answer.retryAt : null };
}

// actions_against_suppressed (README.md "Commands"; beta's rules we keep: suppression is checked just
// before each action), in the caller's tenant run: for each invite or message that went out, contacts'
// suppressedAt of the step's person at the send's instant on LinkedIn (gamma-p7-050: an entry on
// email alone does not count; an opt-out stops every channel), the never-contact list rebuilt as it
// stood then (a removed entry keeps removed_at). An entry added after the send, or removed before it,
// does not count. A person erased since the send (person_not_found) is not counted either: the send
// is listed apart, for sends_person_erased.
import { suppressedAt } from "@whytide/contacts";
import type { Violation } from "./approval.ts";
import { COUNTED_SUPPRESSIONS, LINKEDIN_CHANNEL, PERSON_ERASED } from "./constants.ts";
import type { Send } from "./sends.ts";

/** A send whose person has been erased since: its step and its instant. */
export type ErasedSend = { readonly stepExecutionId: string; readonly at: Date };

/**
 * The sends to a person suppressed at the send, each with the reason, and the sends whose person is
 * erased since, both oldest first (the file's header).
 */
export async function actionsAgainstSuppressed(
  sends: readonly Send[],
): Promise<{ suppressed: Violation[]; erased: ErasedSend[] }> {
  const suppressed: Violation[] = [];
  const erased: ErasedSend[] = [];
  for (const { row, step } of sends) {
    const answer = await suppressedAt(step.personId, row.at, { channel: LINKEDIN_CHANNEL });
    if (!answer.suppressed) continue;
    if (answer.reason === PERSON_ERASED) erased.push({ stepExecutionId: step.id, at: row.at });
    if (!(COUNTED_SUPPRESSIONS as readonly string[]).includes(answer.reason)) continue;
    suppressed.push({ stepExecutionId: step.id, reason: answer.reason, at: row.at });
  }
  return { suppressed, erased };
}

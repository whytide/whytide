// actions_against_suppressed (README.md "Commands"; beta's rules we keep: suppression is checked just
// before each action), in the caller's tenant run: for each invite or message that went out, contacts'
// suppressedAt of the step's person at the send's instant, the never-contact list rebuilt as it stood
// then (a removed entry keeps removed_at). An entry added after the send, or removed before it, does
// not count; nor does a person erased since the send (person_not_found).
import { suppressedAt } from "@whytide/contacts";
import type { Violation } from "./approval.ts";
import { COUNTED_SUPPRESSIONS } from "./constants.ts";
import type { Send } from "./sends.ts";

/** The sends to a person suppressed at the send, oldest first, each with the reason. */
export async function actionsAgainstSuppressed(sends: readonly Send[]): Promise<Violation[]> {
  const found: Violation[] = [];
  for (const { row, step } of sends) {
    const answer = await suppressedAt(step.personId, row.at);
    if (!answer.suppressed) continue;
    if (!(COUNTED_SUPPRESSIONS as readonly string[]).includes(answer.reason)) continue;
    found.push({ stepExecutionId: step.id, reason: answer.reason, at: row.at });
  }
  return found;
}

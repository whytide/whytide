// The wait an approved step shows in "Up next" (beta-p4-040; approvals' noteItemWait), in the
// caller's tenant run: set when the sender puts the step back to wait on the account, linkedin or
// the credits, with the time it waits until when one is known; cleared when it waits on the person
// (touched today, another step in flight) or on nothing, and when the sender claims it again. A step
// with no approved item changes nothing.
import { noteItemWait } from "@whytide/approvals";
import { creditsCodes } from "@whytide/platform";
import { isSendRefusal } from "../steps/codes.ts";
import { PORT_CODE_PREFIX } from "./constants.ts";

/** The waits "Up next" shows: linkedin's refusals, the port's codes and the credits'. */
const shown = (code: string | null): code is string =>
  code !== null &&
  (isSendRefusal(code) ||
    code.startsWith(PORT_CODE_PREFIX) ||
    code === creditsCodes.insufficient_credits);

/** The step's item waits on `code` until `until`, or no longer. */
export async function noteWait(id: string, code: string | null, until: Date | null): Promise<void> {
  await noteItemWait(id, shown(code) ? { code, until } : null);
}

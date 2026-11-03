// The writers' check of a code (constants.ts): skip_reason, error_code and exit_detail take a code
// their list holds. Any other is a developer's mistake, thrown before anything is written; the
// message names the column, never the value, which a mistake could have filled with anything.
import { SEND_REFUSAL_CODES, type SendRefusalCode } from "./constants.ts";

/** The code, when `list` holds it; an error naming `field` otherwise. */
export function checkedCode<const T extends readonly string[]>(
  list: T,
  field: string,
  code: string,
): T[number] {
  if ((list as readonly string[]).includes(code)) return code as T[number];
  throw new Error(`${field}: a code domain/steps/constants.ts does not list`);
}

/** Whether `code` is one of linkedin's refusals before a send's call (constants.ts SEND_REFUSAL_CODES). */
export function isSendRefusal(code: string): code is SendRefusalCode {
  return (SEND_REFUSAL_CODES as readonly string[]).includes(code);
}

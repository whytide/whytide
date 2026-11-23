// The checks on every raw message before any call (README.md "Sending once", F11 §6): CRLF line
// ends; at most MAILBOX_RAW_MAX_BYTES; exactly one Message-ID, equal to the send's messageId and of
// the platform's form; exactly one To, at most TO_MAX_CHARS, with one address; no Cc, no Bcc, no
// Resent- recipient. The port's sendMessage schema runs them, so a failure is mailbox_input_invalid
// and nothing is called. Each problem names a field, never a value: it is an issue in the error's
// details. Each check reads in linear time, and a To over its bound is refused before it is read.
import { MAILBOX_RAW_MAX_BYTES, ONE_RECIPIENT, REFUSED_FIELDS, TO_MAX_CHARS } from "./constants.ts";
import { isPlatformMessageId } from "./message-id.ts";
import { readText, valuesOf } from "./mime.ts";

/** What is wrong with the raw message for a send under `messageId`; none, and it may be sent. */
export function rawMessageProblems(raw: string, messageId: string): string[] {
  if (Buffer.byteLength(raw, "utf8") > MAILBOX_RAW_MAX_BYTES) return ["over MAILBOX_RAW_MAX_BYTES"];
  if (/\r(?!\n)|(?<!\r)\n/.test(raw)) return ["a line end that is not CRLF"];
  const { fields } = readText(raw);
  if (fields === undefined) return ["a header line that is neither a field nor a fold"];
  const problems: string[] = [];
  const ids = valuesOf(fields, "message-id");
  if (ids.length !== 1) problems.push("not exactly one Message-ID");
  else if (ids[0] !== `<${messageId}>`) problems.push("a Message-ID unlike messageId");
  if (!isPlatformMessageId(messageId)) problems.push("a Message-ID not of the platform's form");
  const to = valuesOf(fields, "to");
  if (to.some((value) => value.length > TO_MAX_CHARS)) problems.push("a To over TO_MAX_CHARS");
  else if (to.length !== 1 || !ONE_RECIPIENT.test(to[0] as string))
    problems.push("not exactly one To with one address");
  for (const name of REFUSED_FIELDS)
    if (valuesOf(fields, name).length > 0) problems.push(`a ${name} field`);
  return problems;
}

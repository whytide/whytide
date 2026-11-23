// Reading a report from a raw multipart/report message (RFC 6522), as match.ts asks: a delivery
// status notification (RFC 3464, and RFC 6533's global one) or a feedback report (RFC 5965). It gives
// the original message's Message-ID, from the returned message or its headers, else from the delivery
// status's X-Original-Message-ID or the report's In-Reply-To; a delivery's action and status, its
// first failed recipient's, `5.0.0` for a failed one without a readable status, so permanent; a
// feedback report's type, `other` when none reads. Nothing else is read: no recipient address, no
// text. Plain parsing, no dependency; like mime.ts, it never throws and reads at most READ_MAX_CHARS
// of the message and FIELD_READ_MAX_CHARS of a field's value.
import {
  BOUNCE_STATUS_FORM,
  DELIVERY_ACTIONS,
  DELIVERY_STATUS_TYPES,
  FAILED_ACTION,
  FEEDBACK_REPORT_TYPE,
  FEEDBACK_TYPE_FORM,
  FIELD_NAMES,
  FIELD_READ_MAX_CHARS,
  FIRST_WORD,
  MIME,
  ORIGINAL_TYPES,
  PERMANENT_CLASS,
  READ_MAX_CHARS,
  REPORT_TYPE,
  STATUS_AT_START,
  STATUS_BLOCK_BREAK,
  STATUS_FORM,
  UNKNOWN_FAILURE,
  UNKNOWN_FEEDBACK,
} from "./constants.ts";
import {
  contentTypeOf,
  type HeaderField,
  messageIdOf,
  partsOf,
  readText,
  textOf,
  valuesOf,
} from "./mime.ts";

export type MailboxReport =
  | {
      readonly kind: "delivery";
      readonly originalMessageId: string | null;
      /** `failed`, `delayed`, `delivered`, `relayed` or `expanded`, in lower case; null when none reads. */
      readonly action: string | null;
      /** 2.x.x, 4.x.x or 5.x.x; a failed delivery's is 4.x.x or 5.x.x, `5.0.0` when none reads; another's null when none reads. */
      readonly status: string | null;
      /** A 5.x.x status: the address will never take the message. */
      readonly permanent: boolean;
    }
  | {
      readonly kind: "feedback";
      readonly originalMessageId: string | null;
      /** `abuse`, `fraud`, `virus`, `other`, `not-spam` or `auth-failure`, in lower case; `other` when none reads. */
      readonly feedbackType: string;
    };
type Part = { readonly type: string; readonly content: () => string };

/** The report in the raw message; undefined when it is none, or holds no delivery status or feedback report. */
export function readReport(raw: string): MailboxReport | undefined {
  const { fields = [], body } = readText(raw.slice(0, READ_MAX_CHARS));
  const { type, params } = contentTypeOf(fields);
  const boundary = params.get(MIME.boundary);
  if (type !== REPORT_TYPE || !boundary) return undefined;
  const parts = partsOf(body, boundary).map(partOf);
  const report = parts.find(
    (part) => DELIVERY_STATUS_TYPES.includes(part.type) || part.type === FEEDBACK_REPORT_TYPE,
  );
  if (report === undefined) return undefined;
  const returned = parts.find((part) => ORIGINAL_TYPES.includes(part.type));
  const original = returned && firstId(readText(returned.content()).fields, FIELD_NAMES.messageId);
  const inReplyTo = firstId(fields, FIELD_NAMES.inReplyTo);
  if (report.type === FEEDBACK_REPORT_TYPE) {
    const feedbackType = feedbackTypeOf(report.content());
    return { kind: "feedback", originalMessageId: original ?? inReplyTo, feedbackType };
  }
  const { xOriginal, ...delivery } = deliveryOf(report.content());
  return { kind: "delivery", originalMessageId: original ?? xOriginal ?? inReplyTo, ...delivery };
}

/** A part's type, and its content decoded by its transfer encoding, read when asked. */
function partOf(part: string): Part {
  const { fields = [], body } = readText(part);
  return { type: contentTypeOf(fields).type, content: () => textOf(fields, body).trimStart() };
}

/** The message's block, then one block per recipient: the first failed one's action and status, else the first's. */
function deliveryOf(content: string) {
  const blocks = content.split(STATUS_BLOCK_BREAK).map((block) => readText(block).fields ?? []);
  const recipients = blocks.filter((block) => valuesOf(block, FIELD_NAMES.action).length > 0);
  const actionOf = (block: readonly HeaderField[]) => {
    const word = wordOf(valuesOf(block, FIELD_NAMES.action)[0]);
    return word !== null && DELIVERY_ACTIONS.includes(word) ? word : null;
  };
  const chosen = recipients.find((block) => actionOf(block) === FAILED_ACTION) ?? recipients[0];
  const action = chosen === undefined ? null : actionOf(chosen);
  const read = statusOf(chosen === undefined ? undefined : valuesOf(chosen, FIELD_NAMES.status)[0]);
  const bounceStatus = read !== null && BOUNCE_STATUS_FORM.test(read);
  const status = action === FAILED_ACTION && !bounceStatus ? UNKNOWN_FAILURE : read;
  return {
    action,
    status,
    permanent: status?.startsWith(PERMANENT_CLASS) ?? false,
    xOriginal: firstId(blocks[0], FIELD_NAMES.xOriginalMessageId),
  };
}

function feedbackTypeOf(content: string): string {
  const type = wordOf(valuesOf(readText(content).fields ?? [], FIELD_NAMES.feedbackType)[0]);
  return type !== null && FEEDBACK_TYPE_FORM.test(type) ? type : UNKNOWN_FEEDBACK;
}

/** A field value's first word, in lower case: `failed (bad address)` is `failed`. */
const wordOf = (value: string | undefined): string | null =>
  FIRST_WORD.exec((value ?? "").slice(0, FIELD_READ_MAX_CHARS))?.[1]?.toLowerCase() ?? null;

/** The status at the start of a Status field's value: `5.1.1 (bad address)` is `5.1.1`. */
function statusOf(value: string | undefined): string | null {
  const status = STATUS_AT_START.exec((value ?? "").slice(0, FIELD_READ_MAX_CHARS))?.[1];
  return status !== undefined && STATUS_FORM.test(status) ? status : null;
}

const firstId = (fields: readonly HeaderField[] | undefined, name: string): string | null =>
  messageIdOf(valuesOf(fields ?? [], name)[0]);

// The platform's Message-ID (README.md "Sending once", briefs RB-12.3.4): MAILBOX_MESSAGE_ID_PREFIX
// and the SHA-256 of the step's idempotency key, at the sender's domain in lower case, so that one key
// always gives one Message-ID and the key itself never reaches the recipient. A thread the platform
// started opens with a message of this form (match.ts); a send carries one (raw.ts).
import { createHash } from "node:crypto";
import { MAILBOX_MESSAGE_ID_PREFIX, MESSAGE_ID_HASH, PLATFORM_MESSAGE_ID } from "./constants.ts";

/** The Message-ID a send under the key carries, without its angle brackets. */
export function messageIdFor({
  idempotencyKey,
  domain,
}: {
  readonly idempotencyKey: string;
  readonly domain: string;
}): string {
  const hash = createHash(MESSAGE_ID_HASH).update(idempotencyKey).digest("hex");
  return `${MAILBOX_MESSAGE_ID_PREFIX}${hash}@${domain.toLowerCase()}`;
}

/** Whether a Message-ID, without its angle brackets, is of the platform's form. */
export function isPlatformMessageId(messageId: string | null | undefined): messageId is string {
  return typeof messageId === "string" && PLATFORM_MESSAGE_ID.test(messageId);
}

// Unipile's webhooks (README.md "Webhooks", "Pairing"). The three sources, messaging, users and
// account_status, are registered with the Unipile-Auth header: when present, it is compared with
// UNIPILE_WEBHOOK_SECRET in constant time before the body is read. The hosted-auth notify comes
// without it, so a request without the header is a notify or nothing. Its proof is the pairing token
// in its `name`, an HMAC-SHA-256 of the link's providerRef under the same secret, checked on the raw
// text before the body is parsed and its account id read. JSON.parse never runs on a body that has
// neither proof. Then the mapping, in the port's words: a message, a new relation, every account
// status (an unknown one reads as disconnected, never `ignored`), and any other event of a verified
// source `ignored`. A refusal's details are the method and the reason, never the body.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@whytide/platform";
import { z } from "zod";
import type { PortImplementation } from "../../_pattern/index.ts";
import { type LinkedinWebhookEvent, linkedinPort } from "../port.ts";
import {
  CONNECTED_STATUSES,
  CREDENTIALS_STATUS,
  EVENT_KEY_SEPARATOR,
  MESSAGE_EVENT,
  NOTIFY_STATUSES,
  PAIRING_NAMES,
  PAIRING_SEPARATOR,
  RELATION_EVENT,
  SECRET_HEADER,
} from "./constants.ts";

type Event = LinkedinWebhookEvent;
export type Webhooks = {
  /** The `name` a hosted link is made with: its providerRef, the separator, its pairing token. */
  readonly pairingName: (providerRef: string) => string;
  readonly parseWebhook: PortImplementation<typeof linkedinPort>["parseWebhook"];
};

const ref = z.string().min(1).max(256);
/** An id Unipile may leave out: the ref, else undefined. */
const idOf = (value: unknown) => ref.safeParse(value).data;
/** A chat member as Unipile gives one; its id may be missing (z.unknown() alone is required). */
const member = z.object({ attendee_provider_id: z.unknown().optional() });
/** A messaging event of message_received: what message.received needs; nothing else is read. */
const messageBody = z.object({
  account_id: ref,
  account_info: z.object({ user_id: z.unknown().optional() }).nullish(),
  chat_id: ref,
  message_id: ref,
  /** Null or absent for a message that is an attachment only. */
  message: z.string().nullish(),
  timestamp: z.string(),
  sender: member.nullish(),
  attendees: z.array(member).nullish(),
});
/** A users event of new_relation: the member who accepted; no id and no time of its own. */
const relationBody = z.object({ account_id: ref, user_provider_id: ref });
/** An account_status event: the account and its status, whatever the status, if any. */
const statusBody = z.object({
  AccountStatus: z.object({ account_id: ref, message: z.unknown().optional() }),
});
/** Any event of the messaging and users sources: its name. */
const sourceBody = z.object({ event: z.string() });
/** The hosted-auth notify: the link's name with its new account. */
const notifyBody = z.object({ status: z.enum(NOTIFY_STATUSES), account_id: ref, name: z.string() });

export function webhooks(secret: string): Webhooks {
  const expected = digest(secret);
  const tokenOf = (providerRef: string) =>
    createHmac("sha256", secret).update(providerRef).digest("base64url");
  /** The one pairing name in a raw text whose token verifies, compared in constant time. */
  const pairedName = (text: string): string | undefined => {
    const names = new Set(text.match(PAIRING_NAMES) ?? []);
    const [name] = names;
    if (names.size !== 1 || name === undefined) return undefined;
    const at = name.lastIndexOf(PAIRING_SEPARATOR);
    const given = Buffer.from(name.slice(at + 1));
    const wanted = Buffer.from(tokenOf(name.slice(0, at)));
    return given.length === wanted.length && timingSafeEqual(given, wanted) ? name : undefined;
  };
  return {
    pairingName: (providerRef) => `${providerRef}${PAIRING_SEPARATOR}${tokenOf(providerRef)}`,
    parseWebhook: async ({ headers, rawBody }) => {
      const given = Object.entries(headers).find(([name]) => name.toLowerCase() === SECRET_HEADER);
      const value = given?.[1];
      if (value === undefined) {
        const text = textOf(rawBody);
        return pairedNotify(text, pairedName(text));
      }
      if (typeof value !== "string" || !timingSafeEqual(digest(value), expected)) {
        throw webhookInvalid("secret");
      }
      return sourceEvent(jsonOf(textOf(rawBody)));
    },
  };
}

/** A request without the header: the notify of a link Whytide made, its name verified first. */
function pairedNotify(text: string, name: string | undefined): Event {
  if (name === undefined) throw webhookInvalid("token");
  const notify = notifyBody.safeParse(jsonOf(text));
  if (!notify.success || notify.data.name !== name) throw webhookInvalid("body");
  const providerRef = name.slice(0, name.lastIndexOf(PAIRING_SEPARATOR));
  return { kind: "account.connected", providerAccountRef: notify.data.account_id, providerRef };
}

/** A verified source's event: an account status, a message, a new relation, else `ignored`. */
function sourceEvent(body: unknown): Event {
  if (typeof body === "object" && body !== null && Object.hasOwn(body, "AccountStatus")) {
    return statusEvent(body);
  }
  const source = sourceBody.safeParse(body);
  if (!source.success) throw webhookInvalid("body");
  if (source.data.event === MESSAGE_EVENT) return messageEvent(body);
  if (source.data.event === RELATION_EVENT) return relationEvent(body);
  return { kind: "ignored" };
}

/** OK and the successes connected, CREDENTIALS credentials, any other status disconnected. */
function statusEvent(body: unknown): Event {
  const status = statusBody.safeParse(body);
  if (!status.success) throw webhookInvalid("body");
  const { account_id: providerAccountRef, message } = status.data.AccountStatus;
  if (CONNECTED_STATUSES.has(message)) return { kind: "account.connected", providerAccountRef };
  if (message === CREDENTIALS_STATUS) {
    return { kind: "account.credentials_required", providerAccountRef };
  }
  return { kind: "account.disconnected", providerAccountRef };
}

/**
 * A message in one of the account's chats. It is the account's own only when its sender's id is the
 * account's, `account_info.user_id`; a missing id reads as inbound. Without the sender's id, the
 * sender is the chat's one attendee other than the account; with neither, the body is refused.
 */
function messageEvent(body: unknown): Event {
  const message = messageBody.safeParse(body);
  if (!message.success) throw webhookInvalid("body");
  const { data } = message;
  const accountId = idOf(data.account_info?.user_id);
  const senderId = idOf(data.sender?.attendee_provider_id);
  const attendeeMemberRefs = (data.attendees ?? []).flatMap(
    ({ attendee_provider_id: id }) => idOf(id) ?? [],
  );
  const others = [...new Set(attendeeMemberRefs.filter((id) => id !== accountId))];
  const senderMemberRef = senderId ?? (others.length === 1 ? others[0] : undefined);
  const sentAt = Date.parse(data.timestamp);
  if (senderMemberRef === undefined || Number.isNaN(sentAt)) throw webhookInvalid("body");
  return {
    kind: "message.received",
    providerAccountRef: data.account_id,
    eventKey: data.message_id,
    chatRef: data.chat_id,
    messageRef: data.message_id,
    senderMemberRef,
    fromAccount: senderId !== undefined && senderId === accountId,
    attendeeMemberRefs,
    text: data.message ?? "",
    sentAt: new Date(sentAt),
  };
}

/** A new relation: the acceptance of an invitation, keyed by the account and the member. */
function relationEvent(body: unknown): Event {
  const relation = relationBody.safeParse(body);
  if (!relation.success) throw webhookInvalid("body");
  const { account_id: providerAccountRef, user_provider_id: memberRef } = relation.data;
  const eventKey = [RELATION_EVENT, providerAccountRef, memberRef].join(EVENT_KEY_SEPARATOR);
  return { kind: "invite.accepted", providerAccountRef, eventKey, memberRef };
}

/** Nothing of the body or the secret in it. */
const webhookInvalid = (reason: "secret" | "token" | "body") =>
  new AppError(linkedinPort.errors.linkedin_webhook_invalid, {
    details: { method: "parseWebhook", reason },
  });
const digest = (value: string) => createHash("sha256").update(value).digest();
const textOf = (rawBody: string | Uint8Array) =>
  typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8");

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

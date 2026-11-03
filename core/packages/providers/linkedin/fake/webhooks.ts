// The LinkedIn fake's webhooks (../README.md "Events"): its vendor format, a JSON body whose `type`
// names the kind, in the fake's own words, signed with an HMAC-SHA256 of the raw body in
// SIGNATURE_HEADER. The secret is TEST_WEBHOOK_SECRET under APP_ENV=test, so that a webhook a test
// signed verifies in a separately started api (alpha revisit p7-010), and drawn at start anywhere
// else; nothing logs it. verifiedEvent() checks the signature in constant time before it reads the
// body: a signed body of a type the fake does not send is `ignored`, one of a type it sends but off
// its format linkedin_webhook_invalid. The bounds are the port's, which the boundary checks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, platformConfig } from "@whytide/platform";
import { z } from "zod";
import {
  LINKEDIN_EVENT_STATUSES,
  LINKEDIN_WEBHOOK_KINDS,
  type LinkedinWebhook,
  type LinkedinWebhookEvent,
  linkedinPort,
} from "../port.ts";
import { SIGNATURE_HEADER, TEST_WEBHOOK_SECRET } from "./constants.ts";

const SECRET =
  platformConfig.APP_ENV === "test" ? Buffer.from(TEST_WEBHOOK_SECRET) : randomBytes(32);
const id = z.string().min(1);
const instant = z.iso.datetime();

/** The body of each type the fake sends, its `type` the kind. */
const fakeBody = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("account.connected"), account: id, link: id.optional() }),
  z.strictObject({ type: z.literal("account.disconnected"), account: id }),
  z.strictObject({ type: z.literal("account.credentials_required"), account: id }),
  z.strictObject({
    type: z.literal("account.status"),
    account: id,
    status: z.enum(LINKEDIN_EVENT_STATUSES),
  }),
  z.strictObject({
    type: z.literal("invite.accepted"),
    account: id,
    id,
    member: id,
    at: instant.optional(),
  }),
  z.strictObject({
    type: z.literal("message.received"),
    account: id,
    id,
    chat: id,
    sender: id,
    from_account: z.boolean(),
    attendees: z.array(z.string()),
    text: z.string(),
    sent_at: instant,
  }),
]);
/** A body the fake signs: what its helpers send. */
export type FakeBody = z.input<typeof fakeBody>;
const typed = z.object({ type: z.string() });
/** The types the fake sends: the port's kinds, `ignored` aside. */
const SENT: ReadonlySet<string> = new Set(LINKEDIN_WEBHOOK_KINDS.filter((k) => k !== "ignored"));

const signature = (rawBody: string | Uint8Array, secret: Uint8Array) =>
  `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

/** The body as the fake sends it: its JSON, signed. */
export function signed(body: FakeBody): LinkedinWebhook {
  const rawBody = JSON.stringify(body);
  const headers = {
    "content-type": "application/json",
    [SIGNATURE_HEADER]: signature(rawBody, SECRET),
  };
  return { headers, rawBody };
}

/** A copy whose signature is wrong: its body's HMAC under a secret drawn for it, other headers kept. */
export function forged(webhook: LinkedinWebhook): LinkedinWebhook {
  const { headers, rawBody } = webhook;
  const kept = Object.entries(headers).filter(([name]) => name.toLowerCase() !== SIGNATURE_HEADER);
  const copy = typeof rawBody === "string" ? rawBody : Uint8Array.from(rawBody);
  const wrong = signature(copy, randomBytes(32));
  return { headers: { ...Object.fromEntries(kept), [SIGNATURE_HEADER]: wrong }, rawBody: copy };
}

/** The event a webhook says, its signature checked before its body is read. */
export function verifiedEvent({ headers, rawBody }: LinkedinWebhook): LinkedinWebhookEvent {
  const given = Object.entries(headers).find(([name]) => name.toLowerCase() === SIGNATURE_HEADER);
  if (!signatureMatches(rawBody, given?.[1])) throw webhookInvalid("signature");
  const body = jsonOf(rawBody);
  const type = typed.safeParse(body);
  if (!type.success) throw webhookInvalid("body");
  if (!SENT.has(type.data.type)) return { kind: "ignored" };
  const known = fakeBody.safeParse(body);
  if (!known.success) throw webhookInvalid("body");
  return eventOf(known.data);
}

/** Compared in constant time; a missing or repeated header never matches. */
function signatureMatches(rawBody: string | Uint8Array, given: unknown): boolean {
  if (typeof given !== "string") return false;
  const [expected, actual] = [Buffer.from(signature(rawBody, SECRET)), Buffer.from(given)];
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function jsonOf(rawBody: string | Uint8Array): unknown {
  try {
    return JSON.parse(
      typeof rawBody === "string" ? rawBody : Buffer.from(rawBody).toString("utf8"),
    );
  } catch {
    return undefined;
  }
}

/** Nothing of the body or the secret in it. */
const webhookInvalid = (reason: string) =>
  new AppError(linkedinPort.errors.linkedin_webhook_invalid, {
    details: { method: "parseWebhook", reason },
  });

/** The body in the port's words; a message's id is its eventKey too. */
function eventOf(body: z.output<typeof fakeBody>): LinkedinWebhookEvent {
  switch (body.type) {
    case "account.connected": {
      const link = body.link === undefined ? {} : { providerRef: body.link };
      return { kind: body.type, providerAccountRef: body.account, ...link };
    }
    case "account.disconnected":
    case "account.credentials_required":
      return { kind: body.type, providerAccountRef: body.account };
    case "account.status":
      return { kind: body.type, providerAccountRef: body.account, status: body.status };
    case "invite.accepted": {
      const at = body.at === undefined ? {} : { occurredAt: new Date(body.at) };
      const { account, id: eventKey, member: memberRef } = body;
      return { kind: body.type, providerAccountRef: account, eventKey, memberRef, ...at };
    }
    case "message.received":
      return {
        kind: body.type,
        providerAccountRef: body.account,
        eventKey: body.id,
        chatRef: body.chat,
        messageRef: body.id,
        senderMemberRef: body.sender,
        fromAccount: body.from_account,
        attendeeMemberRefs: body.attendees,
        text: body.text,
        sentAt: new Date(body.sent_at),
      };
  }
}

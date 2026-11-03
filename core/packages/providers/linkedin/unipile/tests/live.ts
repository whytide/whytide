// The live suite's world and the gate of its send cases (README.md "Sandbox", "Live sends"): what
// contract.test.ts runs against Unipile, held to account by
// ../../../tests/safety/unipile-no-live-send.test.ts. The suite starts only when a UNIPILE_TEST_*
// variable names something live, so that the adapter's own variables never reach the network alone.
// The read cases keep alpha's variables: the account UNIPILE_TEST_ACCOUNT_ID names, else the first
// connected one, then UNIPILE_TEST_POST_URL and UNIPILE_TEST_PROFILE_URL. The send cases get a
// recipient through the gate only: all three of UNIPILE_TEST_ACCOUNT_ID (the sender),
// UNIPILE_TEST_RECIPIENT_PROVIDER_ID (a second account the owner controls) and UNIPILE_LIVE_SENDS=1,
// never under APP_ENV=production. They never pick an account or a recipient themselves, and a run
// sends at most one invitation, withdrawn at once even when its case fails midway, and one message.
// The event cases get Unipile's events built here and signed with UNIPILE_WEBHOOK_SECRET, for a
// made-up account: nothing is read or sent for them (README.md "Webhooks").
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { bindPort, type PortInstance } from "../../../_pattern/index.ts";
import type { LinkedinWorld, LinkedinWorldEvent } from "../../contract.ts";
import { type LinkedinWebhook, type LinkedinWebhookEvent, linkedinPort } from "../../port.ts";
import { TIMEOUT_MS } from "../constants.ts";
import { SECRET_HEADER, unipileAdapter } from "../index.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Linkedin = PortInstance<typeof linkedinPort>;
type Member = { readonly providerAccountRef: string; readonly memberRef: string };
export type LiveSends = { readonly accountRef: string; readonly recipientRef: string };

/** The one value of UNIPILE_LIVE_SENDS that opens the gate. */
const OPEN = "1";
/** Pages of pending invitations the clean-up reads at most: a cursor that loops stops here. */
const PAGES_AT_MOST = 50;
const MESSAGES = {
  "account.connected": "CREATION_SUCCESS",
  "account.disconnected": "DELETED",
  "account.credentials_required": "CREDENTIALS",
} as const;
/** The account the world's events name, and its own member id: made up, never read. */
const EVENT_ACCOUNT = "contract-account";
const EVENT_SELF = "contract-member-self";

/** The UNIPILE_TEST_* variables set; with none, the suite does not start. */
export const liveVariables = (env: Env) =>
  Object.keys(env).filter((name) => name.startsWith("UNIPILE_TEST_") && env[name]);

/**
 * The send gate: the sender and the recipient when all three variables are set, else undefined.
 * Under APP_ENV=production it throws, so that the suite fails to start rather than send.
 */
export function liveSendGate(env: Env): LiveSends | undefined {
  const accountRef = env.UNIPILE_TEST_ACCOUNT_ID;
  const recipientRef = env.UNIPILE_TEST_RECIPIENT_PROVIDER_ID;
  if (!accountRef || !recipientRef || env.UNIPILE_LIVE_SENDS !== OPEN) return undefined;
  if (env.APP_ENV === "production") {
    throw new Error("the Unipile live send cases are refused under APP_ENV=production");
  }
  return { accountRef, recipientRef };
}

export function unipileWorld(env: Env): LinkedinWorld {
  const sends = liveSendGate(env);
  let account: string | undefined;
  let adapter: Linkedin | undefined;
  /** The case running, which connect() is handed first: the invitation's clean-up hangs on it. */
  let current: TestContext | undefined;
  const handed = new Set<"invitation" | "message">();
  const linkedin = () =>
    (adapter ??= bindPort(linkedinPort, unipileAdapter.create(), { adapter: "unipile" }));
  const sender = async () =>
    (account ??= env.UNIPILE_TEST_ACCOUNT_ID || (await firstConnected(env)));

  const world: LinkedinWorld = {
    // The hosted-auth notify of an account connected through the link, as Unipile sends it: no
    // header, the name the link was made with, its providerRef and pairing token.
    connect: async (link, t) => {
      current = t;
      const body = {
        status: "CREATION_SUCCESS",
        account_id: await sender(),
        name: pairingName(env, link.providerRef),
      };
      return { headers: { "content-type": "application/json" }, rawBody: JSON.stringify(body) };
    },
    post: async () => {
      const postUrl = variable(env, "UNIPILE_TEST_POST_URL");
      const providerAccountRef = await sender();
      let [engagers, cursor] = [0, undefined as string | null | undefined];
      while (cursor !== null) {
        const page = await linkedin().listPostEngagers({
          providerAccountRef,
          postUrl,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        [engagers, cursor] = [engagers + page.engagers.length, page.nextCursor];
      }
      return { postUrl, engagers };
    },
    profile: async () => ({ profileUrl: variable(env, "UNIPILE_TEST_PROFILE_URL") }),
    webhook: async ({ kind, providerAccountRef }, { forged = false } = {}) => {
      const body = {
        account_id: providerAccountRef,
        account_type: "LINKEDIN",
        message: MESSAGES[kind],
      };
      const secret = forged ? `${env.UNIPILE_WEBHOOK_SECRET}-forged` : undefined;
      return signed(env, { AccountStatus: body }, secret);
    },
    event: async (kind) => {
      const account = EVENT_ACCOUNT;
      const id = randomUUID();
      const member = `contract-member-${id}`;
      switch (kind) {
        case "account.connected":
        case "account.disconnected":
        case "account.credentials_required": {
          const status = { account_id: account, account_type: "LINKEDIN", message: MESSAGES[kind] };
          return made(env, { AccountStatus: status }, { kind, providerAccountRef: account });
        }
        case "account.status":
          return undefined; // Unipile's statuses map to alpha's three kinds (README.md "Webhooks").
        case "invite.accepted": {
          const body = { event: "new_relation", account_id: account, user_provider_id: member };
          const eventKey = `new_relation:${account}:${member}`;
          return made(env, body, {
            kind,
            providerAccountRef: account,
            eventKey,
            memberRef: member,
          });
        }
        case "message.received": {
          const messageRef = `contract-message-${id}`;
          const chatRef = `contract-chat-${id}`;
          const text = "A reply to the LinkedIn port's contract suite";
          const sentAt = new Date();
          const body = {
            event: "message_received",
            account_id: account,
            account_info: { type: "LINKEDIN", user_id: EVENT_SELF },
            chat_id: chatRef,
            message_id: messageRef,
            message: text,
            timestamp: sentAt.toISOString(),
            sender: { attendee_provider_id: member },
            attendees: [{ attendee_provider_id: member }],
          };
          return made(env, body, {
            kind,
            providerAccountRef: account,
            eventKey: messageRef,
            chatRef,
            messageRef,
            senderMemberRef: member,
            fromAccount: false,
            attendeeMemberRefs: [member],
            text,
            sentAt,
          });
        }
        case "ignored": {
          const body = { event: "message_reaction", account_id: account, reaction: "👍" };
          return made(env, body, { kind });
        }
      }
    },
  };
  if (sends === undefined) return world;
  return {
    ...world,
    // The named recipient, when it fits the case: a stranger to invite, a relation to message.
    recipient: async (providerAccountRef, { relation = false } = {}) => {
      assert.equal(
        providerAccountRef,
        sends.accountRef,
        "a send from UNIPILE_TEST_ACCOUNT_ID only",
      );
      const kind = relation ? "message" : "invitation";
      if (handed.has(kind)) return undefined;
      const member = { providerAccountRef, memberRef: sends.recipientRef };
      const { connected, invitationPending } = await linkedin().getRelation(member);
      if (invitationPending || connected !== relation) return undefined;
      handed.add(kind);
      if (!relation) current?.after(() => withdrawLeft(linkedin(), member));
      return sends.recipientRef;
    },
  };
}

/** Alpha's sandbox account: the first LinkedIn account whose sources all run, never redirected. */
async function firstConnected(env: Env): Promise<string> {
  const response = await fetch(new URL("/api/v1/accounts", env.UNIPILE_BASE_URL), {
    headers: { accept: "application/json", "x-api-key": env.UNIPILE_API_KEY ?? "" },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  assert.equal(response.status, 200, "GET /api/v1/accounts");
  const { items } = (await response.json()) as {
    items: { id: string; type: string; sources: { status: string }[] }[];
  };
  const found = items.find(
    ({ type, sources }) => type === "LINKEDIN" && sources.every(({ status }) => status === "OK"),
  );
  assert.ok(found, 'a LinkedIn account connected by hand in the sandbox (README.md "Sandbox")');
  return found.id;
}

/**
 * After the invitation case: the recipient's pending invitation, if the case failed before it
 * withdrew it. The recipient had none pending when the case began (recipient()), so any is the case's.
 */
async function withdrawLeft(linkedin: Linkedin, { providerAccountRef, memberRef }: Member) {
  let cursor: string | null = null;
  for (let pages = 0; pages === 0 || cursor !== null; pages++) {
    assert.ok(pages < PAGES_AT_MOST, "listPendingInvites ends");
    const page = await linkedin.listPendingInvites({
      providerAccountRef,
      ...(cursor ? { cursor } : {}),
    });
    for (const { invitationRef } of page.invites.filter(
      (invite) => invite.memberRef === memberRef,
    )) {
      await linkedin.withdrawInvite({ providerAccountRef, invitationRef });
    }
    cursor = page.nextCursor;
  }
}

function variable(env: Env, name: string): string {
  const value = env[name];
  assert.ok(value, `${name} (README.md "Sandbox")`);
  return value;
}

const signed = (env: Env, body: unknown, secret = env.UNIPILE_WEBHOOK_SECRET ?? "") =>
  ({
    headers: { "content-type": "application/json", [SECRET_HEADER]: secret },
    rawBody: JSON.stringify(body),
  }) satisfies LinkedinWebhook;

/** An event signed as Unipile signs its sources, a forged copy and what parseWebhook gives for it. */
const made = (env: Env, body: unknown, expected: LinkedinWebhookEvent): LinkedinWorldEvent => ({
  webhook: signed(env, body),
  forged: signed(env, body, `${env.UNIPILE_WEBHOOK_SECRET}-forged`),
  expected,
});

/** The name createHostedAuthLink made the link with: its providerRef, a dot, its pairing token. */
const pairingName = (env: Env, providerRef: string) =>
  `${providerRef}.${createHmac("sha256", env.UNIPILE_WEBHOOK_SECRET ?? "")
    .update(providerRef)
    .digest("base64url")}`;

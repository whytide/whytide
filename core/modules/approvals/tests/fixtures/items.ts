// What approvals' tests share: a workspace with the sender account's owner and another member, the
// account (linkedin's factory) and a lead (contacts' commands); a mailbox, written straight to
// email's tables (gamma-p4-090); a tenant run; a step's item opened through openItem, its draft
// ended as its writer ends it and messaging.step_draft_ready delivered to this module's subscriber
// as the outbox delivers it; the approvals.item_decided payloads; messaging's AI disclosure lines,
// as its message file holds them. The test file calls withTestDb() and the clients' use*() first.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { ids as emailIds } from "@whytide/email";
import { createConnectedAccount } from "@whytide/linkedin/testing";
import { events as messaging } from "@whytide/messaging";
import { writeMessageDraft } from "@whytide/messaging/testing";
import { newId, type Principal, servicePrincipal, subscribersOf } from "@whytide/platform";
import { createOrganizationWithWorkspace, createUser } from "@whytide/tenancy/testing";
import { type OpenItemInput, openItem } from "../../domain/items/open.ts";
import { type Item, itemColumns } from "../../domain/items/store.ts";

useHashSalt("test-salt-".repeat(4));
const service = servicePrincipal("approvals_test");

/** One tenant run in the workspace as the app role, as a service. */
export const run = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal: service }, fn, { client: asRole("app") });

export const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The SHA-256 of "": a note left empty. */
export const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/**
 * A message that passes every gate of checkText, the owner's edit of it, and a typed note, which
 * names the post's topic, never the act (gamma-p3-070's signal_act).
 */
export const TEXT =
  "Ines, how does your team follow up on warm leads today? A short question about it.";
export const EDITED =
  "Ines, how does your team follow up on warm leads this week? A short question about it.";
export const NOTE = "Ines, I read the post on losing warm leads. Happy to connect.";
/** A first email's subject that passes its gates, and the owner's edit of it. */
export const SUBJECT = "Warm leads at Acme";
export const EDITED_SUBJECT = "Warm leads this week";

const messagingWords: Record<string, string> = JSON.parse(
  readFileSync(new URL("../../../messaging/messages/en.json", import.meta.url), "utf8"),
);
/** messaging's AI disclosure line of each channel, which the mode's approval ends a text with. */
export const LINE = {
  linkedin: messagingWords["messaging.disclosure.linkedin"] ?? "",
  email: messagingWords["messaging.disclosure.email"] ?? "",
} as const;
/** An email's frozen content's hash, as messaging computes it: its body and subject together. */
export const emailHash = (body: string, subject: string | null) =>
  sha256(JSON.stringify({ body, subject }));

let made = 0;
/** A new step execution's id, as campaigns makes one. */
export const stepId = () => `sx_test${++made}`;

/** A member signed in, as the api's guard leaves the principal. */
const member = (workspaceId: string, userId: string): Principal => {
  const role = "Member";
  return { userId, actorType: "human", authMethod: "session", workspaceId, role, scopes: [] };
};

export type Seeded = Awaited<ReturnType<typeof seed>>;

/** A workspace, the sender account's owner and another member, the account (UTC), a lead. */
export async function seed() {
  const { workspace } = await createOrganizationWithWorkspace();
  const workspaceId = workspace.id;
  const [owner, other] = [await createUser(), await createUser()];
  const { id: accountId } = await createConnectedAccount(workspaceId, { ownerUserId: owner.id });
  const personId = await run(workspaceId, async () => {
    const linkedinUrl = `https://linkedin.com/in/ines-${workspaceId}`;
    const profile = { linkedinUrl, firstName: "Ines", lastName: "Duarte", companyName: "Acme" };
    const { person } = await upsertPersonFromSource({
      source: "linkedin",
      provider: null,
      profile,
    });
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
    return person.id;
  });
  const [ownerId, otherId] = [owner.id, other.id];
  const [asOwner, asOther] = [member(workspaceId, ownerId), member(workspaceId, otherId)];
  return { workspaceId, accountId, personId, ownerId, otherId, asOwner, asOther };
}

/** openItem for a new step of the seeded lead, a message unless the key is `connect`. */
export async function open(seeded: Seeded, step: Partial<OpenItemInput> = {}) {
  const stepKey = step.stepKey ?? "message_1";
  const input: OpenItemInput = {
    ...{ stepExecutionId: stepId(), personId: seeded.personId, senderAccountId: seeded.accountId },
    ...{ actionType: stepKey === "connect" ? "invite" : "message", stepKey },
    ...{ scheduledFor: new Date(), senderUserId: seeded.ownerId, ...step },
  };
  const { approvalItemId } = await run(seeded.workspaceId, () => openItem(input));
  return { approvalItemId, stepExecutionId: input.stepExecutionId };
}

let mailboxes = 0;
/** Never opened: approvals reads a mailbox's owner, address and zone only. */
const TOKEN_REF = new Uint8Array([0]);

/**
 * A mailbox of the user, written straight to email's tables as its callback leaves one, at an
 * address of its own (a mailbox's near-duplicate gate compares its own emails): connected, or
 * disconnected by the user when they have one connected here already (one each, email's index),
 * which approvals reads all the same. Its id.
 */
export async function createMailbox(
  workspaceId: string,
  ownerUserId: string,
  timeZone = "UTC",
): Promise<string> {
  const db = asRole("app");
  const domain = "example.com";
  const { id: sendingDomainId } = await db.sendingDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain } },
    create: { id: newId(emailIds.sending_domain), workspaceId, domain },
    update: {},
    select: { id: true },
  });
  const id = newId(emailIds.mailbox);
  const mailbox = { id, workspaceId, ownerUserId, sendingDomainId, provider: "google" as const };
  const address = { emailAddress: `member-${++mailboxes}@${domain}`, displayName: "Test Member" };
  const at = new Date();
  const where = { workspaceId, ownerUserId, status: "connected" as const };
  const state =
    (await db.mailbox.count({ where })) === 0
      ? { status: "connected" as const, oauthTokenRef: TOKEN_REF }
      : {
          status: "disconnected" as const,
          disconnectedReason: "user" as const,
          disconnectedAt: at,
        };
  const columns = { scopes: [], isFreeConsumer: false, timeZone, connectedAt: at, ...state };
  await db.mailbox.create({ data: { ...mailbox, ...address, ...columns } });
  return id;
}

/**
 * openItem for a new email step of the seeded lead, `email_1` unless given, from a mailbox of its
 * own, the owner's unless given.
 */
export async function openEmail(seeded: Seeded, step: Partial<OpenItemInput> = {}) {
  const mailboxId = step.mailboxId ?? (await createMailbox(seeded.workspaceId, seeded.ownerId));
  const input: OpenItemInput = {
    ...{ stepExecutionId: stepId(), personId: seeded.personId, mailboxId },
    ...{ actionType: "email", stepKey: "email_1" },
    ...{ scheduledFor: new Date(), senderUserId: seeded.ownerId, ...step },
  };
  const { approvalItemId } = await run(seeded.workspaceId, () => openItem(input));
  return { approvalItemId, stepExecutionId: input.stepExecutionId, mailboxId };
}

/** An email step's item with its draft ended `ready` and attached: a first one with SUBJECT. */
export async function readyEmail(seeded: Seeded, step: Partial<OpenItemInput> = {}) {
  const opened = await openEmail(seeded, step);
  const subject = (step.stepKey ?? "email_1") === "email_1" ? SUBJECT : null;
  await endDraft(seeded.workspaceId, opened.stepExecutionId, "ready", TEXT, subject);
  return opened;
}

export const itemOf = (workspaceId: string, id: string): Promise<Item> =>
  run(workspaceId, (tx) =>
    tx.approvalItem.findFirstOrThrow({ where: { id }, select: itemColumns }),
  );

/** The step's draft, which messaging made: the columns the tests read. */
export const draftOf = (
  workspaceId: string,
  stepExecutionId: string,
): Promise<{ id: string; status: string; editedText: string | null }> => {
  const select = { id: true, status: true, editedText: true };
  return run(workspaceId, (tx) =>
    tx.messageDraft.findFirstOrThrow({ where: { stepExecutionId }, select }),
  );
};

type DraftEnd = "ready" | "flagged" | "failed" | "edited";

/** messaging.step_draft_ready delivered to the subscribers, in a tenant run as the outbox does. */
export const deliverDraftEnd = (
  workspaceId: string,
  payload: { draftId: string; stepExecutionId: string; status: Exclude<DraftEnd, "edited"> },
) =>
  run(workspaceId, async (tx) => {
    const name = messaging["messaging.step_draft_ready"];
    const context = { id: "obx_test", name, workspaceId, createdAt: new Date(), attempt: 1, tx };
    for (const handler of subscribersOf(name)) await handler(payload, context);
  });

/**
 * The step's `drafting` draft written as its writer ends it, a first email's with its subject, then
 * its event delivered; `edited`, which no writer leaves, is delivered as `ready`.
 */
export async function endDraft(
  workspaceId: string,
  stepExecutionId: string,
  status: DraftEnd = "ready",
  text: string | null = status === "failed" ? null : TEXT,
  subject: string | null = null,
): Promise<string> {
  const { id: draftId } = await draftOf(workspaceId, stepExecutionId);
  await writeMessageDraft(draftId, { status, text, subject }, asRole("app"));
  const ended = status === "edited" ? "ready" : status;
  await deliverDraftEnd(workspaceId, { draftId, stepExecutionId, status: ended });
  return draftId;
}

/** A step's item with its draft ended and attached; a note is at its open. */
export async function readyItem(seeded: Seeded, step: Partial<OpenItemInput> = {}) {
  const opened = await open(seeded, step);
  if (step.stepKey !== "connect") await endDraft(seeded.workspaceId, opened.stepExecutionId);
  return opened;
}

/** The payloads of approvals.item_decided in the workspace, oldest first. */
export const decisions = async (workspaceId: string) => {
  const where = { workspaceId, eventName: "approvals.item_decided" };
  const orderBy = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  return (await asRole("app").outboxEntry.findMany({ where, orderBy })).map((row) => row.payload);
};

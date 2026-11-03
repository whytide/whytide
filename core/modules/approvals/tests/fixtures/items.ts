// What approvals' tests share: a workspace with the sender account's owner and another member, the
// account (linkedin's factory) and a lead (contacts' commands); a tenant run; a step's item opened
// through openItem, its draft ended as its writer ends it and messaging.step_draft_ready delivered
// to this module's subscriber as the outbox delivers it; the approvals.item_decided payloads. The
// test file calls withTestDb() and the clients' use*() first.
import { createHash } from "node:crypto";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import { createConnectedAccount } from "@whytide/linkedin/testing";
import { events as messaging } from "@whytide/messaging";
import { writeMessageDraft } from "@whytide/messaging/testing";
import { type Principal, servicePrincipal, subscribersOf } from "@whytide/platform";
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
/** A message that passes every gate of checkText, the owner's edit of it, and a typed note. */
export const TEXT =
  "Ines, how does your team follow up on warm leads today? A short question about it.";
export const EDITED =
  "Ines, how does your team follow up on warm leads this week? A short question about it.";
export const NOTE = "Ines, I read your comment on losing warm leads. Happy to connect.";

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

type DraftEnd = "ready" | "flagged" | "failed";

/** messaging.step_draft_ready delivered to the subscribers, in a tenant run as the outbox does. */
export const deliverDraftEnd = (
  workspaceId: string,
  payload: { draftId: string; stepExecutionId: string; status: DraftEnd },
) =>
  run(workspaceId, async (tx) => {
    const name = messaging["messaging.step_draft_ready"];
    const context = { id: "obx_test", name, workspaceId, createdAt: new Date(), attempt: 1, tx };
    for (const handler of subscribersOf(name)) await handler(payload, context);
  });

/** The step's `drafting` draft written as its writer ends it, then its event delivered. */
export async function endDraft(
  workspaceId: string,
  stepExecutionId: string,
  status: DraftEnd = "ready",
  text: string | null = status === "failed" ? null : TEXT,
): Promise<string> {
  const { id: draftId } = await draftOf(workspaceId, stepExecutionId);
  await writeMessageDraft(draftId, { status, text }, asRole("app"));
  await deliverDraftEnd(workspaceId, { draftId, stepExecutionId, status });
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

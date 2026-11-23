// The setup inbox's test files share (tests/safety/reply-hold.test.ts, tests/store.test.ts,
// tests/tenancy.test.ts, tests/erase.test.ts, tests/safety/tester-touch.test.ts, tests/sent.test.ts),
// each file on its own schema (withTestDb, called by the file): a workspace's runs as a service, the
// approver's connected account, a person whose lead is in a campaign with steps in every state
// (campaigns' rows written as its enrollment and the later tasks leave them: inbox imports campaigns'
// index only), a message step sent (campaigns', messaging's, approvals' and linkedin's rows as the
// send leaves them), the file of a message as linkedin's receiver writes it, the account's own
// message through the activity's body, a failure inside the store's run, and the rows as the tests
// read them.
import { createHash, randomUUID } from "node:crypto";
import { createApprovalItem } from "@whytide/approvals/testing";
import {
  createLeadForPerson,
  recordLeadStatus,
  recordTouch,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { type PrismaClient, type TenantClient, withTenant } from "@whytide/db";
import { asRole } from "@whytide/db/testing";
import type { MessageFile } from "@whytide/linkedin";
import { createConnectedAccount, createOutreach } from "@whytide/linkedin/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import { filesPort, getAdapter } from "@whytide/providers";
import type { StoreResult } from "../domain/store/store.ts";
import { storeMessage } from "../workflows/index.ts";

/** The template's steps, each in the state a test starts from: the request sent, three pending. */
export const STEPS = [
  ["connect", "succeeded"],
  ["message_1", "scheduled"],
  ["follow_up_1", "awaiting_approval"],
  ["follow_up_2", "planned"],
] as const;
/** The steps after a reply: the sent one kept, every pending one held. */
export const HELD = [
  ["connect", "succeeded", null],
  ["message_1", "held", "replied"],
  ["follow_up_1", "held", "replied"],
  ["follow_up_2", "held", "replied"],
];
/** The steps before a reply, as stepsOf reads them. */
export const PENDING = STEPS.map(([key, status]) => [key, status, null]);
const TEMPLATE_ID = "linkedin_default";
/** The connected account's owner, who approves its steps. */
export const OWNER = "usr_inbox_owner";
/** The person's member ref at the provider, as the receiver's files name it. */
const MEMBER = "member-noor";
const HOUR_MS = 3_600_000;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A thread as the tests read it. */
export type ThreadRow = {
  readonly id: string;
  readonly personId: string;
  readonly providerThreadRef: string;
  readonly lastMessageAt: Date;
};
/** A message as the tests read it. */
export type MessageRow = {
  readonly id: string;
  readonly threadId: string;
  readonly personId: string;
  readonly direction: string;
  readonly body: string;
  readonly providerMessageRef: string | null;
  readonly sentAt: Date;
  readonly optOutMatched: boolean;
};
/** A message step sent: its id, the provider's refs linkedin keeps, the approved text and times. */
export type SentStep = {
  readonly stepExecutionId: string;
  readonly chatRef: string;
  readonly messageRef: string;
  readonly text: string;
  readonly executedAt: Date;
  readonly approvedAt: Date;
};
export type Fixture = {
  readonly app: () => PrismaClient;
  readonly run: <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
  /** A person whose lead is in_campaign, enrolled on the account, the steps as STEPS has them. */
  readonly enrolled: (senderAccountId: string, slug: string) => Promise<string>;
  /**
   * The person's message_1, or the step given, sent with `text` at `executedAt`, approved an hour
   * before by OWNER, or by the campaign's mode (the text then frozen with `line` after it, no
   * approver; gamma-p4-090): the step `succeeded`, its frozen draft and approved item, linkedin's
   * outreach row with the refs, and the touch the send recorded.
   */
  readonly sent: (
    senderAccountId: string,
    personId: string,
    text: string,
    executedAt?: Date,
    approval?: { readonly stepKey?: string; readonly line?: string },
  ) => Promise<SentStep>;
  /** The account's own message through inbox_store's body, its file put on the files fake first. */
  readonly storeOwn: (
    input: { readonly personId: string; readonly senderAccountId: string },
    file: MessageFile,
  ) => Promise<{ readonly result: StoreResult; readonly fileKey: string }>;
  /** The approver's connected account, OWNER's unless given another owner. */
  readonly account: (ownerUserId?: string) => Promise<{ id: string }>;
  /** The person's steps as [key, status, skip_reason], by position. */
  readonly stepsOf: (personId: string) => Promise<(string | null)[][]>;
  readonly leadOf: (personId: string) => Promise<string>;
  /** The workspace's opt-outs, as [source, reason], oldest first. */
  readonly optOuts: () => Promise<(string | null)[][]>;
  /** The names of the workspace's outbox events, oldest first. */
  readonly eventNames: () => Promise<string[]>;
  readonly threads: () => Promise<ThreadRow[]>;
  readonly messages: () => Promise<MessageRow[]>;
};

/** The helpers of one workspace. */
export function fixture(workspaceId: string): Fixture {
  const app = (): PrismaClient => asRole("app");
  const run = <T>(fn: (tx: TenantClient) => Promise<T>) =>
    withTenant({ workspaceId, principal: servicePrincipal("inbox_test") }, fn, { client: app() });

  /** A person whose lead is in_campaign, enrolled on the account, the steps as STEPS has them. */
  async function enrolled(senderAccountId: string, slug: string): Promise<string> {
    const personId = await run(async () => {
      const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Noor" };
      const { person } = await upsertPersonFromSource({
        source: "import",
        provider: "csv",
        profile,
      });
      await createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      const actor = { type: "system" } as const;
      await recordLeadStatus(person.id, "approved", { actor });
      await recordLeadStatus(person.id, "in_campaign", { actor, templateId: TEMPLATE_ID });
      return person.id;
    });
    const enrollmentId = newId("enl");
    const owner = { workspaceId, personId, senderAccountId, templateId: TEMPLATE_ID };
    const enrollment = {
      status: "active" as const,
      sourceEventId: newId("obx"),
      startedAt: new Date(),
    };
    await app().enrollment.create({
      data: { id: enrollmentId, ...owner, templateVersion: 1, ...enrollment },
    });
    await app().stepExecution.createMany({
      data: STEPS.map(([stepKey, status], i) => ({
        ...{ id: newId("sx"), enrollmentId, ...owner, templateVersion: 1, stepKey, status },
        ...{ position: i + 1, actionType: i === 0 ? ("invite" as const) : ("message" as const) },
        ...{ stepTemplateHash: randomUUID(), idempotencyKey: randomUUID() },
      })),
    });
    return personId;
  }

  async function sent(
    senderAccountId: string,
    personId: string,
    text: string,
    executedAt = new Date(),
    approval: { readonly stepKey?: string; readonly line?: string } = {},
  ): Promise<SentStep> {
    const { stepKey = "message_1", line } = approval;
    const where = { personId, stepKey };
    const { id: stepExecutionId } = await app().stepExecution.findFirstOrThrow({ where });
    const approvedAt = new Date(executedAt.getTime() - HOUR_MS);
    const step = { stepExecutionId, stepKey };
    const draftId = newId("mdr");
    // The mode's approval freezes the text with its line after a blank line, as messaging does.
    const frozen = line === undefined ? text : `${text}\n\n${line}`;
    const byMode = line === undefined ? {} : { editedText: frozen, disclosureApplied: true };
    await app().messageDraft.create({
      data: {
        ...{ id: draftId, workspaceId, personId, ...step, text, approvedAt, ...byMode },
        ...({ channel: "linkedin_message", kind: "outbound_step", status: "approved" } as const),
      },
    });
    const decided =
      line === undefined
        ? { decidedBy: OWNER }
        : { decisionOrigin: "approval_mode" as const, approvalBy: "mode" as const };
    const approvalItemId = await createApprovalItem(
      {
        ...{ workspaceId, personId, senderAccountId, ...step, status: "approved", draftId },
        ...{ approvedContentHash: sha256(frozen), decidedAt: approvedAt, ...decided },
      },
      app(),
    );
    await app().stepExecution.update({
      where: { id: stepExecutionId },
      data: { status: "succeeded", executedAt, approvalItemId, draftId },
    });
    const refs = { chatRef: `chat-${randomUUID()}`, messageRef: `message-${randomUUID()}` };
    const outreach = { senderAccountId, personId, providerMemberRef: MEMBER };
    const { id } = await createOutreach(workspaceId, {
      ...outreach,
      providerChatRef: refs.chatRef,
    });
    await app().senderOutreach.update({
      where: { id },
      data: { lastStepExecutionId: stepExecutionId, lastMessageRef: refs.messageRef },
    });
    await run(() => recordTouch(personId, executedAt));
    return { stepExecutionId, ...refs, text: frozen, executedAt, approvedAt };
  }

  async function storeOwn(
    input: { readonly personId: string; readonly senderAccountId: string },
    file: MessageFile,
  ) {
    const files = await getAdapter(filesPort, "fake");
    const put = { workspaceId, key: `raw/linkedin/messages/${randomUUID()}.json` };
    const body = JSON.stringify(file);
    const { key: fileKey } = await files.put({ ...put, body, contentType: "application/json" });
    const store = { workspaceId, ...input, direction: "out", fileKey } as const;
    const result = await storeMessage({ workspaceId, tenant: run }, store);
    return { result, fileKey };
  }

  return {
    app,
    run,
    enrolled,
    sent,
    storeOwn,
    account: (ownerUserId = OWNER) => createConnectedAccount(workspaceId, { ownerUserId }),
    stepsOf: async (personId) =>
      (
        await app().stepExecution.findMany({ where: { personId }, orderBy: { position: "asc" } })
      ).map(({ stepKey, status, skipReason }) => [stepKey, status, skipReason]),
    leadOf: async (personId) =>
      (await app().lead.findFirstOrThrow({ where: { personId } })).outreachStatus,
    optOuts: async () =>
      (
        await app().suppressionEntry.findMany({
          where: { workspaceId, layer: "opt_out" },
          orderBy: { createdAt: "asc" },
        })
      ).map(({ source, reason }) => [source, reason]),
    eventNames: async () =>
      (await app().outboxEntry.findMany({ where: { workspaceId }, orderBy: { id: "asc" } })).map(
        ({ eventName }) => eventName,
      ),
    threads: () =>
      app().thread.findMany({
        where: { workspaceId },
        orderBy: { id: "asc" },
        select: { id: true, personId: true, providerThreadRef: true, lastMessageAt: true },
      }),
    messages: () =>
      app().message.findMany({
        where: { workspaceId },
        orderBy: { id: "asc" },
        select: {
          ...{ id: true, threadId: true, personId: true, direction: true, body: true },
          ...{ providerMessageRef: true, sentAt: true, optOutMatched: true },
        },
      }),
  };
}

/** The file of the person's reply, as linkedin's receiver writes it; fresh refs unless given. */
export function replyFile(text: string, given: Partial<MessageFile> = {}): MessageFile {
  return {
    chatRef: `chat-${randomUUID()}`,
    messageRef: `message-${randomUUID()}`,
    senderMemberRef: MEMBER,
    attendeeMemberRefs: ["member-self"],
    fromAccount: false,
    sentAt: new Date().toISOString(),
    text,
    ...given,
  };
}

/** The file of the account's own message to the person, as the receiver writes it; as replyFile. */
export function ownFile(text: string, given: Partial<MessageFile> = {}): MessageFile {
  const own = { senderMemberRef: "member-self", attendeeMemberRefs: [MEMBER], fromAccount: true };
  return replyFile(text, { ...own, ...given });
}

/**
 * While fn runs, a write to the table fails inside the store's run: each insert, or the commit (a
 * deferred constraint trigger, which fires as the transaction commits, after every write of the run).
 */
export async function failing(
  table: "messages" | "outbox",
  when: "insert" | "commit",
  fn: () => Promise<void>,
): Promise<void> {
  const owner = asRole("owner");
  const trigger =
    when === "commit"
      ? `CREATE CONSTRAINT TRIGGER fail_store AFTER INSERT ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_store()`
      : `CREATE TRIGGER fail_store BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_store()`;
  await owner.$executeRawUnsafe(
    "CREATE FUNCTION fail_store() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'the store fails'; END $$",
  );
  await owner.$executeRawUnsafe(trigger);
  try {
    await fn();
  } finally {
    await owner.$executeRawUnsafe(`DROP TRIGGER fail_store ON ${table}`);
    await owner.$executeRawUnsafe("DROP FUNCTION fail_store()");
  }
}

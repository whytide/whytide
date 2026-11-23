// test:tenancy for inbox's tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): a thread, a message, a reply's label, a reply draft and a
// reply's classification, written by the store's run, the label, the draft's run and the
// classifier's write of one workspace and read in a run of each workspace, the threads through the
// list's query, the rest through the scoped client, are that workspace's only; and the store's
// writes, the reads, the label, the eraser, a reply's run, begin and settle (gamma-p4-060), a reply
// draft's request, read, failure and sweep (inbox-reply-draft) and the classifier's write
// (gamma-p4-040) go through the tenant client.
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { fallback, writeClassification } from "../domain/classify/write.ts";
import { erasePerson } from "../domain/erase.ts";
import { setLabel } from "../domain/labels/label.ts";
import { prepareReply } from "../domain/reply/begin.ts";
import { requestReply } from "../domain/reply/request.ts";
import { settleReply } from "../domain/reply/settle.ts";
import { readReplyDraft, requestReplyDraft } from "../domain/reply-draft/request.ts";
import { markReplyDraftFailed, sweepStuckReplyDrafts } from "../domain/reply-draft/write.ts";
import { insertInbound } from "../domain/store/message.ts";
import { storeInbound } from "../domain/store/store.ts";
import { upsertThread } from "../domain/store/thread.ts";
import { listThreads, readThread } from "../domain/threads/queries.ts";
import { createReplyDraft } from "../testing/index.ts";
import { fixture, OWNER, replyFile } from "./fixtures.ts";
import { human } from "./reply-fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));

/** A reply stored in the workspace by the store's run: the person's id. */
async function replied(workspaceId: string): Promise<string> {
  const { run, account, enrolled } = fixture(workspaceId);
  const { id: senderAccountId } = await account();
  const personId = await enrolled(senderAccountId, "tenancy");
  const file = replyFile("Thanks, next week works.");
  await run(() => storeInbound({ personId, senderAccountId, file, now: new Date() }));
  return personId;
}

isolationTest("threads", {
  async createRow(workspaceId) {
    const personId = await replied(workspaceId);
    const where = { personId };
    return fixture(workspaceId).run(() => tenantClient.thread.findFirstOrThrow({ where }));
  },
  // The list answers its caller's own threads (gamma-p6-060): the account's owner reads them.
  readAs: (workspaceId) =>
    withTenant(
      { workspaceId, principal: human(OWNER, workspaceId) },
      async () => (await listThreads({ limit: 50 })).threads,
      { client: asRole("app") },
    ),
});

isolationTest("messages", {
  async createRow(workspaceId) {
    const personId = await replied(workspaceId);
    const where = { personId };
    return fixture(workspaceId).run(() => tenantClient.message.findFirstOrThrow({ where }));
  },
  readAs: (workspaceId) => fixture(workspaceId).run(() => tenantClient.message.findMany()),
});

isolationTest("reply_labels", {
  async createRow(workspaceId) {
    const personId = await replied(workspaceId);
    return fixture(workspaceId).run(async () => {
      const { id } = await tenantClient.message.findFirstOrThrow({ where: { personId } });
      await setLabel(id, "interested", OWNER);
      return tenantClient.replyLabel.findFirstOrThrow({ where: { messageId: id } });
    });
  },
  readAs: (workspaceId) => fixture(workspaceId).run(() => tenantClient.replyLabel.findMany()),
});

isolationTest("reply_drafts", {
  async createRow(workspaceId) {
    const personId = await replied(workspaceId);
    return fixture(workspaceId).run(async (tx) => {
      const { id: threadId } = await tenantClient.thread.findFirstOrThrow({ where: { personId } });
      const id = await createReplyDraft({ workspaceId, threadId }, tx);
      return tenantClient.replyDraft.findUniqueOrThrow({ where: { id } });
    });
  },
  readAs: (workspaceId) => fixture(workspaceId).run(() => tenantClient.replyDraft.findMany()),
});

isolationTest("reply_classifications", {
  async createRow(workspaceId) {
    const personId = await replied(workspaceId);
    return fixture(workspaceId).run(async () => {
      const { id, threadId } = await tenantClient.message.findFirstOrThrow({ where: { personId } });
      await writeClassification({ messageId: id, threadId, personId }, fallback(null));
      return tenantClient.replyClassification.findFirstOrThrow({ where: { messageId: id } });
    });
  },
  readAs: (workspaceId) =>
    fixture(workspaceId).run(() => tenantClient.replyClassification.findMany()),
});

test("the store's writes, the reads, the label, the eraser, a reply, a reply draft and a classification go through the tenant client", async () => {
  const at = new Date();
  const thread = { senderAccountId: "sac_unknown", ownerUserId: "usr_unknown" };
  await assertScoped(() =>
    upsertThread({ ...thread, personId: "per_unknown", providerThreadRef: "chat", sentAt: at }),
  );
  const message = { threadId: "thr_unknown", personId: "per_unknown", body: "Thanks." };
  await assertScoped(() =>
    insertInbound({
      ...message,
      providerMessageRef: "m",
      sentAt: at,
      receivedAt: at,
      optOutMatched: false,
    }),
  );
  await assertScoped(() =>
    storeInbound({ personId: "per_unknown", senderAccountId: "sac_unknown", file: null, now: at }),
  );
  await assertScoped(() => erasePerson("per_unknown"));
  await assertScoped(() => listThreads({ limit: 1 }));
  await assertScoped(() => readThread("thr_unknown"));
  await assertScoped(() => setLabel("msg_unknown", "interested", "usr_unknown"));
  await assertScoped(() => requestReply("thr_unknown", "Thanks."));
  await assertScoped(() => prepareReply("msg_unknown"));
  const reply = {
    messageId: "msg_unknown",
    accountId: "sac_unknown",
    reservationId: "sqr_unknown",
  };
  await assertScoped(() => settleReply({ ...reply, phase: "send", answer: null, code: null }, at));
  await assertScoped(() => requestReplyDraft("thr_unknown", "Offer a call."));
  await assertScoped(() => readReplyDraft("thr_unknown"));
  await assertScoped(() => markReplyDraftFailed("rdr_unknown", "write_failed"));
  await assertScoped(() => sweepStuckReplyDrafts(at));
  const request = { messageId: "msg_unknown", threadId: "thr_unknown", personId: "per_unknown" };
  await assertScoped(() => writeClassification(request, fallback(null)));
});

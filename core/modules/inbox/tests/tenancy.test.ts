// test:tenancy for inbox's tables (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): a thread, a message and a reply's label, written by the
// store's run and the label of one workspace and read in a run of each workspace, the threads through
// the list's query, the rest through the scoped client, are that workspace's only; and the store's
// writes, the reads, the label and the eraser go through the tenant client.
import test from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { tenantClient } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { erasePerson } from "../domain/erase.ts";
import { setLabel } from "../domain/labels/label.ts";
import { insertInbound } from "../domain/store/message.ts";
import { storeInbound } from "../domain/store/store.ts";
import { upsertThread } from "../domain/store/thread.ts";
import { listThreads, readThread } from "../domain/threads/queries.ts";
import { fixture, replyFile } from "./fixtures.ts";

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
  readAs: (workspaceId) =>
    fixture(workspaceId).run(async () => (await listThreads({ limit: 50 })).threads),
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
      await setLabel(id, "positive", "usr_tenancy");
      return tenantClient.replyLabel.findFirstOrThrow({ where: { messageId: id } });
    });
  },
  readAs: (workspaceId) => fixture(workspaceId).run(() => tenantClient.replyLabel.findMany()),
});

test("the store's writes, the reads, the label and the eraser go through the tenant client", async () => {
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
  await assertScoped(() => setLabel("msg_unknown", "positive", "usr_unknown"));
});

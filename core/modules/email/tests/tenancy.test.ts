// test:tenancy for sending_domains, mailboxes and mailbox_connects (docs/rules/security.md §3; core/
// packages/db README "Register a tenant table in the isolation test"): a row written in one workspace
// is not read in a run of another; the public read and the disconnects go through the tenant client;
// and the one rule across workspaces, the partial unique index that lets one address be connected in
// one workspace only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { tenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { newId, servicePrincipal } from "@whytide/platform";
import {
  disconnectMailbox,
  findMailbox,
  listMailboxes,
  markTokenRevoked,
} from "../domain/mailboxes.ts";
import { ids } from "../ids.ts";

withTestDb();
const client = asRole("app");
const principal = servicePrincipal("email_test");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

function domain(workspaceId: string, name = "example.com") {
  return client.sendingDomain.upsert({
    where: { workspaceId_domain: { workspaceId, domain: name } },
    create: { id: newId(ids.sending_domain), workspaceId, domain: name },
    update: {},
  });
}

/** A connected mailbox at the address, its blob a stand-in: no test here opens it. */
async function mailbox(workspaceId: string, emailAddress = `member@${workspaceId}.example`) {
  const { id: sendingDomainId } = await domain(workspaceId, emailAddress.split("@")[1]);
  const data = {
    id: newId(ids.mailbox),
    workspaceId,
    ownerUserId: "usr_isolation",
    sendingDomainId,
    provider: "google" as const,
    emailAddress,
    displayName: "Isolation",
    scopes: ["send", "read"],
    oauthTokenRef: new Uint8Array([1]),
    isFreeConsumer: false,
    status: "connected" as const,
    timeZone: "UTC",
    connectedAt: new Date(),
  };
  return client.mailbox.create({ data, select: { id: true } });
}

isolationTest("sending_domains", {
  createRow: (workspaceId) => domain(workspaceId),
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.sendingDomain.findMany()),
});

isolationTest("mailboxes", {
  createRow: (workspaceId) => mailbox(workspaceId),
  readAs: (workspaceId) => inRun(workspaceId, () => listMailboxes()),
});

isolationTest("mailbox_connects", {
  createRow: (workspaceId) =>
    client.mailboxConnect.create({
      data: {
        id: newId(ids.mailbox_connect),
        workspaceId,
        userId: "usr_isolation",
        provider: "microsoft",
        timeZone: "UTC",
        stateHash: "0".repeat(64),
        expiresAt: new Date(),
      },
    }),
  readAs: (workspaceId) => inRun(workspaceId, () => tenantClient.mailboxConnect.findMany()),
});

test("one address is connected in one workspace only, across workspaces, and again once disconnected there; the read and the disconnects go through the tenant client", async () => {
  const first = await mailbox("wsp_first", "shared@example.com");
  await assert.rejects(
    mailbox("wsp_second", "shared@example.com"),
    (error: { code?: string; message?: string }) => {
      assert.equal(error.code, "P2002");
      assert.match(String(error.message), /mailboxes_address_connected/);
      return true;
    },
  );
  const at = new Date();
  await inRun("wsp_first", () =>
    disconnectMailbox({ workspaceId: "wsp_first", mailboxId: first.id, reason: "user", at }),
  );
  await mailbox("wsp_second", "shared@example.com");
  const none = { workspaceId: "wsp_none", mailboxId: "mbx_none", reason: "user" as const, at };
  await assertScoped(() => listMailboxes());
  await assertScoped(() => findMailbox("mbx_none"));
  await assertScoped(() => disconnectMailbox(none));
  await assertScoped(() => markTokenRevoked("mbx_none", at));
});

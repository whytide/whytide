// test:tenancy for message_drafts (docs/rules/security.md §3; core/packages/db README "Register a
// tenant table in the isolation test"): a draft made by the module's command and read in a run of
// one workspace, scoped by the tenant client alone, is that workspace's only; the drafts' commands
// and queries go through the tenant client; erasePerson deletes a person's drafts and no one else's.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import {
  createDraft,
  editDraft,
  erasePerson,
  getDraft,
  listDrafts,
  markFailed,
  regenerateDraft,
  requestDraft,
} from "../domain/drafts/store.ts";

withTestDb();
const principal = servicePrincipal("messaging_test");
const client = asRole("app");
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client });

isolationTest("message_drafts", {
  createRow: (workspaceId) =>
    inRun(workspaceId, () => createDraft({ personId: "per_isolation", channel: "linkedin_note" })),
  readAs: (workspaceId) =>
    withTenant({ workspaceId, principal }, (tx) => tx.messageDraft.findMany(), { client }),
});

test("erasePerson deletes the person's drafts, and no one else's; the commands and queries go through the tenant client", async () => {
  const workspaceId = "wsp_erasure";
  for (const personId of ["per_erased", "per_erased", "per_kept"]) {
    await inRun(workspaceId, () => createDraft({ personId, channel: "linkedin_message" }));
  }
  assert.deepEqual(await inRun(workspaceId, () => erasePerson("per_erased")), {
    message_drafts: 2,
  });
  const left = await client.messageDraft.findMany({ where: { workspaceId } });
  assert.deepEqual(
    left.map((draft) => draft.personId),
    ["per_kept"],
  );
  await assert.rejects(
    inRun(workspaceId, () => erasePerson("")),
    { code: "person_not_found" },
  );

  const note = { personId: "per_none", channel: "linkedin_note" } as const;
  await assertScoped(() => createDraft(note));
  await assertScoped(() => requestDraft(note));
  await assertScoped(() => getDraft("mdr_none"));
  await assertScoped(() => listDrafts("per_none"));
  await assertScoped(() => editDraft("mdr_none", { editedText: "Hello" }));
  await assertScoped(() => regenerateDraft("mdr_none"));
  await assertScoped(() => markFailed("mdr_none"));
  await assertScoped(() => erasePerson("per_none"));
});

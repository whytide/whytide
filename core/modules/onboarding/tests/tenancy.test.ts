// test:tenancy for company_knowledge, website_pages and company_documents (docs/rules/security.md §3;
// core/packages/db README "Register a tenant table in the isolation test"): rows made by the commands,
// read through the tenant client in a run of one workspace. Then the public reads, in the caller's
// run: readCompanyKnowledge refuses another workspace, getCompanyDomain is the website's host, and
// both are scoped, as are the routes' read of the pages, the drafter's reads, the script's and the
// draft review.
import assert from "node:assert/strict";
import test from "node:test";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, assertScoped, isolationTest, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import {
  getCompanyDomain,
  getCompanyKnowledge,
  readCompanyKnowledge,
  saveCompanyKnowledge,
} from "../domain/commands.ts";
import {
  draftDocuments,
  draftPages,
  draftState,
  listCompanyDocuments,
  listWebsitePages,
  recordFetch,
  requestDraft,
} from "../domain/draft.ts";
import { acceptDraft, discardDraft } from "../domain/review.ts";

withTestDb();

const principal = servicePrincipal("onboarding_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

isolationTest("company_knowledge", {
  createRow: (workspaceId) => inRun(workspaceId, () => getCompanyKnowledge(workspaceId)),
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.companyKnowledge.findMany({})),
});

const page = {
  url: "https://acme.test/",
  status: "fetched",
  fetchedAt: new Date(),
  title: "Acme",
  text: "Robots for warehouses",
  contentHash: "0".repeat(64),
} as const;
isolationTest("website_pages", {
  createRow: (workspaceId) =>
    inRun(workspaceId, async (tx) => {
      const record = await saveCompanyKnowledge({
        ...(await getCompanyKnowledge(workspaceId)),
        sourceUrl: page.url,
      });
      await requestDraft(workspaceId);
      const { draftRunId } = await tx.companyKnowledge.findFirstOrThrow({});
      const run = { workspaceId, companyKnowledgeId: record.id, draftRunId: draftRunId ?? "" };
      await recordFetch(run, { ok: true, pages: [page] });
      return tx.websitePage.findFirstOrThrow({});
    }),
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.websitePage.findMany({})),
});

const document = {
  name: "deck.pdf",
  mediaType: "application/pdf",
  status: "read",
  text: "Acme",
} as const;
isolationTest("company_documents", {
  createRow: (workspaceId) =>
    inRun(workspaceId, async (tx) => {
      const record = await getCompanyKnowledge(workspaceId);
      await saveCompanyKnowledge({ ...record, sourceUrl: page.url });
      await requestDraft(workspaceId, [document]);
      return tx.companyDocument.findFirstOrThrow({});
    }),
  readAs: (workspaceId) => inRun(workspaceId, (tx) => tx.companyDocument.findMany({})),
});

test("the public reads run in the caller's run: the record, another workspace refused, the website's domain", async () => {
  const workspaceId = "wsp_reader";
  const record = await inRun(workspaceId, () => readCompanyKnowledge(workspaceId));
  assert.deepEqual([record.fetchStatus, record.version, record.oneLiner], ["none", 1, ""]);
  assert.equal(await inRun(workspaceId, () => getCompanyDomain()), null);
  const sourceUrl = "https://www.acme.test/about";
  await inRun(workspaceId, () => saveCompanyKnowledge({ ...record, sourceUrl }));
  assert.equal(await inRun(workspaceId, () => getCompanyDomain()), "acme.test");
  await assert.rejects(
    inRun(workspaceId, () => readCompanyKnowledge("wsp_other")),
    (error: unknown) => isAppError(error) && error.code === "tenant_mismatch",
  );
  await assertScoped(() => readCompanyKnowledge("wsp_assert"));
  await assertScoped(() => getCompanyDomain());
  await assertScoped(() => listWebsitePages("ck_assert"));
  const run = { workspaceId: "wsp_assert", companyKnowledgeId: "ck_assert", draftRunId: "drun_a" };
  await assertScoped(() => draftPages(run));
  await assertScoped(() => draftDocuments("ck_assert"));
  await assertScoped(() => listCompanyDocuments("ck_assert"));
  await assertScoped(() => draftState());
  await assertScoped(() => acceptDraft(false));
  await assertScoped(() => discardDraft());
});

// `pnpm knowledge:draft` (knowledge-draft; README "The script") on the worktree's database, the
// worker stubbed as the module's tests stub it: the test waits for the run the script starts, then
// writes what the fetch and the drafter end with through recordFetch and recordDraft. The script
// saves the website, starts the Draft with its documents, prints the summary, accepts with --accept;
// with no worker it times out, and a later Draft supersedes its run. A refusal writes nothing. And
// requestDraft's documents (README "The documents"): written in the run's transaction, replaced by
// the next Draft's, removed by a Draft without any.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { DRAFT_USAGE, EXIT } from "../cli/constants.ts";
import { runDraft } from "../cli/draft.ts";
import { getCompanyKnowledge, saveCompanyKnowledge } from "../domain/commands.ts";
import type { DraftDocument } from "../domain/documents.ts";
import {
  type DraftRun,
  draftDocuments,
  listCompanyDocuments,
  recordDraft,
  recordFetch,
  requestDraft,
} from "../domain/draft.ts";
import type { DraftOutput } from "../schemas/draft-company-knowledge.ts";

withTestDb();
// The script finds its workspace through tenancy, here in the test's schema.
useTenancyClient(asRole("app"));

const principal = servicePrincipal("onboarding_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });
/** The script on the test's schema, its reads every 20 ms for five seconds at most. */
const options = { client: asRole("app"), everyMs: 20, forMs: 5_000 };
const FIXTURES = join(import.meta.dirname, "fixtures", "documents");
const SITE = "https://corvid.test/";
const cite = (text: string, sourceUrl: string) => ({ text, sourceUrl, quote: text });
const NOTHING_DRAFTED: DraftOutput = {
  ...{ oneLiner: null, longDescription: null, tone: null },
  ...{ products: [], painPoints: [], featuresBenefits: [], proofPoints: [], competitors: [] },
};
/** A draft citing the website and both documents, the deck's proof point among them. */
const DRAFTED: DraftOutput = {
  ...NOTHING_DRAFTED,
  oneLiner: cite(
    "Corvid moves parcels for small shops, the same day, across the whole city.",
    SITE,
  ),
  products: [
    cite("Same-day parcels", "document:deck.pdf"),
    cite("Rate card", "document:notes.txt"),
  ],
  proofPoints: [cite("Trusted by 300 shops in the city.", "document:deck.pdf")],
};

/** The run the script started, once the record is `fetching` under it. */
async function started(workspaceId: string): Promise<DraftRun> {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(10)) {
    const record = await inRun(workspaceId, (tx) => tx.companyKnowledge.findFirst({}));
    if (record?.fetchStatus === "fetching" && record.draftRunId !== null) {
      return { workspaceId, companyKnowledgeId: record.id, draftRunId: record.draftRunId };
    }
  }
  throw new Error("the script started no Draft within five seconds");
}

/** The worker, stubbed: the run's fetch reads the home page, then the drafter writes `draft`. */
async function worker(workspaceId: string, draft: DraftOutput): Promise<DraftRun> {
  const run = await started(workspaceId);
  const page = { url: SITE, status: "fetched", fetchedAt: new Date(), title: "Corvid" } as const;
  const text = "Corvid moves parcels for small shops.";
  const contentHash = createHash("sha256").update(text).digest("hex");
  await inRun(workspaceId, () =>
    recordFetch(run, { ok: true, pages: [{ ...page, text, contentHash }] }),
  );
  const pending = {
    model: "fake-model",
    promptVersion: 2,
    decisionRecordId: "dec_cli",
    fields: draft,
  };
  await inRun(workspaceId, () => recordDraft(run, { ok: true, draft: pending }, 1));
  return run;
}

test("--url saves the website, the Draft carries the documents to the drafter, the summary prints pages, documents and fields but no text; --accept writes the fields, a document's source kept, and a save after it passes", async () => {
  const workspaceId = "wsp_cli_accept";
  await createOrganizationWithWorkspace({ workspaceId });
  const lines: string[] = [];
  const files = [join(FIXTURES, "deck.pdf"), join(FIXTURES, "notes.txt")];
  const args = [
    "--workspace",
    workspaceId,
    "--url",
    SITE,
    ...files.flatMap((file) => ["--file", file]),
  ];
  const working = worker(workspaceId, DRAFTED);
  const code = await runDraft([...args, "--accept"], (line) => lines.push(line), options);
  const run = await working;
  assert.equal(code, EXIT.done, lines.join("\n"));
  assert.deepEqual(lines, [
    `website_saved: ${SITE}`,
    `draft_requested: run ${run.draftRunId} in ${workspaceId}, 2 document(s)`,
    `page: ${SITE} (fetched)`,
    "document: deck.pdf (read)",
    "document: notes.txt (read)",
    "field oneLiner: Corvid moves parcels for small shops, the same day, across t…",
    "field products: 2 item(s)",
    "field proofPoints: 1 item(s)",
    "draft_accepted: oneLiner, products, proofPoints written, version 3",
  ]);
  const printed = lines.join("\n");
  for (const text of ["Same-day parcels for small shops", "from 4 euros", "Corvid Freight rate"]) {
    assert.ok(!printed.includes(text), `no document's text: ${text}`);
  }
  // What the drafter reads after the pages: each document as document:<name>, in the order given.
  const entries = await inRun(workspaceId, () => draftDocuments(run.companyKnowledgeId));
  assert.deepEqual(
    entries.map(({ url, title, text }) => [url, title, text.split("\n")[0]]),
    [
      ["document:deck.pdf", "deck.pdf", "Corvid Freight"],
      ["document:notes.txt", "notes.txt", "Corvid Freight rate card"],
    ],
  );
  const record = await inRun(workspaceId, () => getCompanyKnowledge(workspaceId));
  assert.deepEqual(
    [record.sourceUrl, record.oneLiner, record.products, record.proofPoints, record.pendingDraft],
    [
      SITE,
      DRAFTED.oneLiner?.text,
      ["Same-day parcels", "Rate card"],
      [{ text: "Trusted by 300 shops in the city.", sourceUrl: "document:deck.pdf" }],
      null,
    ],
  );
  assert.deepEqual(
    [record.fieldSources.products?.sourceUrl, record.fieldSources.proofPoints?.sourceUrl],
    ["document:deck.pdf", "document:deck.pdf"],
  );
  // The Company form's save sends every field back, the document's source with its proof point.
  const saved = await inRun(workspaceId, () => saveCompanyKnowledge({ ...record, tone: "Plain" }));
  assert.deepEqual(
    [saved.version, saved.proofPoints, saved.fieldSources.proofPoints?.kind],
    [4, record.proofPoints, "ai_draft"],
  );
});

test("without --accept the script says where to review the draft and leaves it pending; with no worker it times out and asks whether the worker runs", async () => {
  const workspaceId = "wsp_cli_review";
  await createOrganizationWithWorkspace({ workspaceId });
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  const working = worker(workspaceId, { ...NOTHING_DRAFTED, tone: cite("Plain", SITE) });
  assert.equal(
    await runDraft(["--workspace", workspaceId, "--url", SITE], print, options),
    EXIT.done,
  );
  await working;
  assert.deepEqual(lines.slice(2), [
    `page: ${SITE} (fetched)`,
    "field tone: Plain",
    `draft_ready: review it in the Company screen, /w/${workspaceId}/company`,
  ]);
  const pending = await inRun(workspaceId, () => getCompanyKnowledge(workspaceId));
  assert.deepEqual([pending.tone, pending.pendingDraft?.fields.tone?.text], ["", "Plain"]);

  lines.length = 0;
  const waited = { ...options, forMs: 100 };
  assert.equal(await runDraft(["--workspace", workspaceId], print, waited), EXIT.timeout);
  const run = await started(workspaceId);
  assert.deepEqual(lines, [
    `draft_requested: run ${run.draftRunId} in ${workspaceId}, 0 document(s)`,
    `draft_timeout: run ${run.draftRunId} is still fetching: the worker goes on, and the draft shows in the Company screen, /w/${workspaceId}/company; is the worker running?`,
  ]);
});

test("a Draft started meanwhile, from the Company screen, supersedes the script's run, which writes nothing, and removes its documents", async () => {
  const workspaceId = "wsp_cli_superseded";
  await createOrganizationWithWorkspace({ workspaceId });
  const lines: string[] = [];
  const args = ["--workspace", workspaceId, "--url", SITE, "--file", join(FIXTURES, "faq.md")];
  const later = started(workspaceId).then(() =>
    inRun(workspaceId, () => requestDraft(workspaceId)),
  );
  const code = await runDraft(args, (line) => lines.push(line), options);
  await later;
  assert.equal(code, EXIT.superseded);
  assert.match(
    lines.at(-1) ?? "",
    /^draft_superseded: a later Draft replaced run drun_\w+, which writes nothing$/,
  );
  const record = await inRun(workspaceId, (tx) => tx.companyKnowledge.findFirstOrThrow({}));
  assert.equal(record.fetchStatus, "fetching");
  assert.deepEqual(await inRun(workspaceId, () => listCompanyDocuments(record.id)), []);
});

test("a refusal writes nothing: a usage error, a sixth file, a file of another type, a PDF with no text, no such workspace, a website that is not http or https, no website", async () => {
  const workspaceId = "wsp_cli_refused";
  await createOrganizationWithWorkspace({ workspaceId });
  const named = ["--workspace", workspaceId];
  const withSite = [...named, "--url", SITE];
  const file = (name: string) => ["--file", join(FIXTURES, name)];
  const six = ["deck.pdf", "notes.txt", "faq.md", "scan.pdf", "locked.pdf", "sixth.txt"];
  const cases: [string[], number, string][] = [
    [[...named, "--replace-edited"], EXIT.usage, DRAFT_USAGE],
    [["--url", SITE], EXIT.usage, DRAFT_USAGE],
    [
      [...withSite, ...six.flatMap(file)],
      EXIT.refused,
      `documents_too_many: ${FIXTURES}/sixth.txt`,
    ],
    [
      [...withSite, ...file("deck.docx")],
      EXIT.refused,
      `document_type_unsupported: ${FIXTURES}/deck.docx`,
    ],
    [[...withSite, ...file("scan.pdf")], EXIT.refused, `document_no_text: ${FIXTURES}/scan.pdf`],
    [
      ["--workspace", "wsp_cli_typo", "--url", SITE],
      EXIT.notFound,
      "workspace_not_found: no workspace has the id wsp_cli_typo",
    ],
    [
      ["--workspace", "corvid", "--url", SITE],
      EXIT.notFound,
      "workspace_not_found: no single workspace has the slug corvid: pass its id",
    ],
    [
      [...named, "--url", "ftp://corvid.test/"],
      EXIT.refused,
      "company_knowledge_invalid_url: ftp://corvid.test/",
    ],
    [named, EXIT.refused, `company_knowledge_no_website: ${workspaceId}`],
  ];
  for (const [args, exit, line] of cases) {
    const lines: string[] = [];
    assert.equal(await runDraft(args, (printed) => lines.push(printed), options), exit, line);
    assert.deepEqual(lines, [line]);
  }
  const app = asRole("app");
  const counts = [
    app.companyKnowledge.count(),
    app.companyDocument.count(),
    app.outboxEntry.count(),
  ];
  assert.deepEqual(await Promise.all(counts), [0, 0, 0]);
});

test("requestDraft writes the documents in the run's transaction, each with its text's SHA-256; the next Draft's replace them, and a Draft without any removes them", async () => {
  const workspaceId = "wsp_cli_documents";
  const document = (name: string, text: string): DraftDocument => ({
    ...{ name, mediaType: "text/plain", status: "read", text },
  });
  await inRun(workspaceId, async () => {
    const record = await getCompanyKnowledge(workspaceId);
    await saveCompanyKnowledge({ ...record, sourceUrl: SITE });
  });
  const documentsOf = () =>
    inRun(workspaceId, (tx) => tx.companyDocument.findMany({ orderBy: { id: "asc" } }));
  const drafts = () =>
    inRun(workspaceId, (tx) =>
      tx.outboxEntry.count({ where: { eventName: "onboarding.draft_requested" } }),
    );
  await assert.rejects(
    inRun(workspaceId, async () => {
      await requestDraft(workspaceId, [document("a.txt", "Alpha")]);
      throw new Error("the run fails after the request");
    }),
    /the run fails/,
  );
  assert.deepEqual([await documentsOf(), await drafts()], [[], 0]);

  await inRun(workspaceId, () =>
    requestDraft(workspaceId, [document("a.txt", "Alpha"), document("b.md", "Beta")]),
  );
  const first = await documentsOf();
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.deepEqual(
    first.map(({ name, mediaType, status, text, contentHash }) => [
      name,
      mediaType,
      status,
      text,
      contentHash,
    ]),
    [
      ["a.txt", "text/plain", "read", "Alpha", sha256("Alpha")],
      ["b.md", "text/plain", "read", "Beta", sha256("Beta")],
    ],
  );
  assert.ok(first.every((row) => row.id.startsWith("cdoc_") && row.workspaceId === workspaceId));

  await inRun(workspaceId, () => requestDraft(workspaceId, [document("c.pdf", "Gamma")]));
  assert.deepEqual(
    (await documentsOf()).map(({ name }) => name),
    ["c.pdf"],
  );
  await inRun(workspaceId, () => requestDraft(workspaceId));
  assert.deepEqual([await documentsOf(), await drafts()], [[], 3]);
});

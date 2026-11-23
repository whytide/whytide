// onboarding's Company Knowledge routes end to end (alpha-p4-010, alpha-p4-020, alpha-p4-030;
// core/modules/onboarding/README.md "Routes"): the host started with identity, whose resolver lets a
// member into their workspace, and onboarding, on the fake authentication adapter, in a schema of the
// worktree's database, answering real HTTP; a write sends the app's Origin. The events are read from
// the outbox: the Draft's workflow, which the worker starts from its event, is the worker's test
// (core/apps/worker/tests/onboarding-fetch.test.ts). It lives here: a module never imports a host.
// The Draft's body (onboarding-setup): the documents the Company screen read, and the automatic accept.
// The documents' limits (env-settings-b): each answer carries the settings, here their defaults, which
// the screen reads files by; a sixth document is the domain's documents_too_many, no schema's.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// onboarding by its build's path, as src/modules.generated.ts loads it: its screen depends on the
// web, which depends on the api, so the api's dev dependency on onboarding would close a cycle that
// pnpm refuses to order.
const onboarding = new URL("../../../../modules/onboarding/dist/index.js", import.meta.url).href;
const db = withTestDb();
useTenancyClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "onboarding", load: () => import(onboarding) },
];
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { readonly status: number; readonly body: Record<string, unknown> };

const empty = {
  sourceUrl: null,
  oneLiner: "",
  longDescription: "",
  products: [],
  painPoints: [],
  featuresBenefits: [],
  proofPoints: [],
  competitors: [],
  tone: "",
};

/** The cookie of a new session of the tenant's Owner, or of another user. */
const cookieOf = ({ user }: Pick<TestTenant, "user">) =>
  signInAs(user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

/** GET …/onboarding/company-knowledge of `workspaceId` as `who`, or a PUT of `body` with the app's Origin. */
async function call(who: TestTenant, workspaceId: string, body?: object): Promise<Answer> {
  const url = new URL(`/v1/workspaces/${workspaceId}/onboarding/company-knowledge`, api.url);
  const write = { origin: APP_ORIGIN, "content-type": "application/json" };
  const res = await fetch(url, {
    method: body === undefined ? "GET" : "PUT",
    headers: { cookie: cookieOf(who), ...(body === undefined ? {} : write) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The record's answer without its id and time, which change with every run. */
const fieldsOf = ({ body: { id: _id, updatedAt: _at, ...rest } }: Answer) => rest;

test("the first GET is an empty record; a PUT of a one-liner and two proof points marks them human, moves the version and publishes the event", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const [first, second] = await Promise.all([call(a, workspaceId), call(a, workspaceId)]);
  assert.deepEqual([first.status, second.status], [200, 200]);
  assert.equal(first.body.id, second.body.id, "two first reads at once make one record");
  const initial = {
    ...{ fetchStatus: "none", fetchedAt: null, fetchError: null },
    ...{ fieldSources: {}, pendingDraft: null },
  };
  const documentLimits = { files: 5, bytes: 10 * 1024 * 1024 };
  assert.deepEqual(fieldsOf(first), {
    ...empty,
    ...initial,
    version: 1,
    pages: [],
    documentLimits,
  });

  const proofPoints = [
    { text: "Picking is 40% faster at Beta", sourceUrl: "https://acme.test/customers" },
    { text: "Used in 120 warehouses" },
  ];
  const saved = await call(a, workspaceId, {
    ...empty,
    oneLiner: "Robots for warehouses",
    proofPoints,
  });
  assert.equal(saved.status, 200);
  const {
    oneLiner: one,
    proofPoints: points,
    ...others
  } = saved.body.fieldSources as Record<string, { kind: string; at: string }>;
  assert.deepEqual([one?.kind, points?.kind, others], ["human", "human", {}]);
  assert.ok(Date.parse(one?.at ?? "") > 0, "the mark carries its time");
  assert.deepEqual(
    [saved.body.oneLiner, saved.body.proofPoints, saved.body.version],
    ["Robots for warehouses", proofPoints, 2],
  );
  assert.deepEqual(await call(a, workspaceId), saved, "a reload shows what was saved");
  const where = { workspaceId, eventName: "onboarding.company_knowledge_updated" };
  const outbox = await asRole("app").outboxEntry.findMany({ where });
  assert.deepEqual(
    outbox.map((row) => row.payload),
    [{ workspaceId, version: 2 }],
  );
});

test("a long description of 2,001 characters, a list of 21 items or an ftp website answers 400 with the field's path", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const refused = (code: string, fields: string[]) => ({
    status: 400,
    body: { code, details: { fields } },
  });
  assert.deepEqual(
    await call(a, workspaceId, { ...empty, longDescription: "x".repeat(2001) }),
    refused("validation_failed", ["longDescription"]),
  );
  const items = Array.from({ length: 21 }, (_, at) => `Product ${at}`);
  assert.deepEqual(
    await call(a, workspaceId, { ...empty, products: items }),
    refused("validation_failed", ["products"]),
  );
  assert.deepEqual(
    await call(a, workspaceId, { ...empty, sourceUrl: "ftp://acme.test/" }),
    refused("company_knowledge_invalid_url", ["sourceUrl"]),
  );
  assert.equal((await call(a, workspaceId)).body.version, 1, "nothing was saved");
});

test("workspace B never reads workspace A's record: its own stays empty, A's answers 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const saved = await call(a, a.workspace.id, { ...empty, oneLiner: "Robots for warehouses" });
  assert.equal(saved.status, 200);
  const own = await call(b, b.workspace.id);
  assert.deepEqual([own.status, own.body.oneLiner, own.body.version], [200, "", 1]);
  assert.notEqual(own.body.id, saved.body.id);
  assert.deepEqual(await call(b, a.workspace.id), { status: 403, body: { code: "forbidden" } });
});

/** POST …/company-knowledge/draft of `workspaceId` as `who` under the Idempotency-Key `key`, `input` as JSON. */
async function draft(
  who: Pick<TestTenant, "user">,
  workspaceId: string,
  key: string,
  input?: object,
) {
  const url = new URL(`/v1/workspaces/${workspaceId}/onboarding/company-knowledge/draft`, api.url);
  const headers = { cookie: cookieOf(who), origin: APP_ORIGIN, "idempotency-key": key };
  const json = input === undefined ? {} : { "content-type": "application/json" };
  const sent = input === undefined ? {} : { body: JSON.stringify(input) };
  const res = await fetch(url, { method: "POST", headers: { ...headers, ...json }, ...sent });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, replayed: res.headers.get("idempotent-replayed"), body };
}

test("a Draft without a website answers 409; with one, 202 fetching and one onboarding.draft_requested, its key answered again without a second", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const none = { code: "company_knowledge_no_website" };
  assert.deepEqual(await draft(a, workspaceId, randomUUID()), {
    status: 409,
    replayed: null,
    body: none,
  });
  await call(a, workspaceId, { ...empty, sourceUrl: "https://acme.test/" });
  const key = randomUUID();
  const first = await draft(a, workspaceId, key);
  const { status, replayed, body } = first;
  assert.deepEqual(
    [status, replayed, body.fetchStatus, body.fetchError, body.pages, body.sourceUrl],
    [202, null, "fetching", null, [], "https://acme.test/"],
  );
  assert.deepEqual(await draft(a, workspaceId, key), { ...first, replayed: "true" });
  const record = await asRole("app").companyKnowledge.findFirstOrThrow({ where: { workspaceId } });
  assert.match(record.draftRunId ?? "", /^drun_/);
  const where = { workspaceId, eventName: "onboarding.draft_requested" };
  const outbox = await asRole("app").outboxEntry.findMany({ where });
  assert.deepEqual(
    outbox.map((row) => row.payload),
    [{ workspaceId, companyKnowledgeId: body.id, draftRunId: record.draftRunId }],
    "one event, its ids only: a replay publishes nothing",
  );
  assert.equal((await call(a, workspaceId)).body.fetchStatus, "fetching");
});

/** POST …/company-knowledge/draft/<action> of `workspaceId` as `who`, under a new Idempotency-Key. */
async function review(who: TestTenant, workspaceId: string, action: string, body = {}) {
  const path = `/v1/workspaces/${workspaceId}/onboarding/company-knowledge/draft/${action}`;
  const headers = { cookie: cookieOf(who), origin: APP_ORIGIN, "idempotency-key": randomUUID() };
  const res = await fetch(new URL(path, api.url), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const NOTHING_DRAFTED = {
  ...{ oneLiner: null, longDescription: null, tone: null },
  ...{ products: [], painPoints: [], featuresBenefits: [], proofPoints: [], competitors: [] },
};
const PAGE = "https://acme.test/about";
const cite = (text: string) => ({ text, sourceUrl: PAGE, quote: text });

/** A pending draft of `fields` on the workspace's record, as the drafter writes it. */
async function pending(workspaceId: string, fields: object) {
  const pendingDraft = { model: "fake-model", promptVersion: 1, decisionRecordId: "dec_a", fields };
  const data = { fetchStatus: "drafted", pendingDraft };
  await asRole("app").companyKnowledge.updateMany({ where: { workspaceId }, data });
  return pendingDraft;
}
type Sources = Record<string, { kind: string; at: string; sourceUrl?: string }>;

test("accept writes each drafted field a person did not edit, ai_draft with its page, moves the version and publishes it; replaceEdited takes the edited one too; no draft is 409", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  await call(a, workspaceId, { ...empty, sourceUrl: "https://acme.test/", oneLiner: "Our words" });
  const fields = {
    ...NOTHING_DRAFTED,
    oneLiner: cite("Robots for warehouses"),
    products: [cite("Picking arm"), cite("Cart")],
    tone: cite("Plain"),
  };
  const draft = await pending(workspaceId, fields);
  assert.deepEqual((await call(a, workspaceId)).body.pendingDraft, draft);

  const accepted = await review(a, workspaceId, "accept", {});
  const { status, body } = accepted;
  assert.deepEqual(
    [status, body.oneLiner, body.products, body.tone, body.version, body.pendingDraft],
    [200, "Our words", ["Picking arm", "Cart"], "Plain", 3, null],
  );
  const sources = body.fieldSources as Sources;
  assert.deepEqual(
    [sources.oneLiner?.kind, sources.products, sources.tone?.kind],
    ["human", { kind: "ai_draft", at: sources.products?.at, sourceUrl: PAGE }, "ai_draft"],
  );
  assert.deepEqual(await call(a, workspaceId), accepted, "a reload shows what was accepted");

  await pending(workspaceId, fields);
  const replaced = await review(a, workspaceId, "accept", { replaceEdited: true });
  const { oneLiner, version, fieldSources } = replaced.body;
  assert.deepEqual(
    [oneLiner, version, (fieldSources as Sources).oneLiner?.kind],
    ["Robots for warehouses", 4, "ai_draft"],
  );
  const where = { workspaceId, eventName: "onboarding.company_knowledge_updated" };
  const outbox = await asRole("app").outboxEntry.findMany({ where });
  assert.deepEqual(
    outbox.map((row) => (row.payload as { version: number }).version).sort(),
    [2, 3, 4],
  );
  const none = { status: 409, body: { code: "company_knowledge_no_draft" } };
  assert.deepEqual(await review(a, workspaceId, "accept", {}), none);
  assert.deepEqual(await review(a, workspaceId, "discard"), none);
  assert.deepEqual(await review(a, workspaceId, "accept", { replaceEdited: "yes" }), {
    status: 400,
    body: { code: "validation_failed", details: { fields: ["replaceEdited"] } },
  });
});

test("discard drops the draft and changes no field; another workspace's member answers 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const saved = await call(a, workspaceId, { ...empty, oneLiner: "Our words" });
  await pending(workspaceId, { ...NOTHING_DRAFTED, oneLiner: cite("Robots"), tone: cite("Plain") });
  assert.deepEqual(await review(b, workspaceId, "discard"), {
    status: 403,
    body: { code: "forbidden" },
  });
  const discarded = await review(a, workspaceId, "discard");
  const kept = ({ body }: Answer) => [body.oneLiner, body.tone, body.version, body.fieldSources];
  assert.deepEqual([discarded.status, discarded.body.pendingDraft], [200, null]);
  assert.deepEqual(kept(discarded), kept(saved));
  const where = { workspaceId, eventName: "onboarding.company_knowledge_updated" };
  assert.equal((await asRole("app").outboxEntry.findMany({ where })).length, 1, "the save's only");
});

const doc = (name: string, text: string, more: object = {}) => ({
  ...{ name, mediaType: "text/plain", status: "read", text },
  ...more,
});

test("a Draft's documents start it without a website, each stored with its text; neither a website nor a document is 409, with a body or without; a Member answers 403", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const none = { status: 409, replayed: null, body: { code: "company_knowledge_no_website" } };
  assert.deepEqual(await draft(a, workspaceId, randomUUID(), {}), none);
  assert.deepEqual(await draft(a, workspaceId, randomUUID(), { autoAccept: true }), none);
  const documents = [
    doc("deck.pdf", "Corvid Freight", { mediaType: "application/pdf", status: "truncated" }),
    doc("faq.md", "# Questions", { mediaType: "text/markdown" }),
  ];
  const started = await draft(a, workspaceId, randomUUID(), { documents });
  assert.deepEqual(
    [started.status, started.body.fetchStatus, started.body.sourceUrl],
    [202, "fetching", null],
  );
  const app = asRole("app");
  const record = await app.companyKnowledge.findFirstOrThrow({ where: { workspaceId } });
  const stored = await app.companyDocument.findMany({
    where: { workspaceId },
    orderBy: { id: "asc" },
  });
  assert.deepEqual(
    stored.map(({ name, mediaType, status, text }) => ({ name, mediaType, status, text })),
    documents,
  );
  assert.equal(record.draftAutoAccept, false, "no autoAccept: the draft waits for review");

  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const refused = await draft({ user: member }, workspaceId, randomUUID(), { documents });
  assert.deepEqual([refused.status, refused.body], [403, { code: "forbidden" }]);
  const where = { workspaceId, eventName: "onboarding.draft_requested" };
  assert.equal(await app.outboxEntry.count({ where }), 1, "the Owner's Draft only");
});

test("autoAccept is the run's: a Draft with it marks the run, the next without it clears it; five documents of 50,000 three-byte characters fit the body", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  await call(a, workspaceId, { ...empty, sourceUrl: "https://acme.test/" });
  const flag = async () =>
    (await asRole("app").companyKnowledge.findFirstOrThrow({ where: { workspaceId } }))
      .draftAutoAccept;
  const auto = await draft(a, workspaceId, randomUUID(), { autoAccept: true });
  assert.deepEqual([auto.status, auto.body.fetchStatus, await flag()], [202, "fetching", true]);
  assert.equal((await draft(a, workspaceId, randomUUID())).status, 202, "no body: as before");
  assert.equal(await flag(), false);
  const full = Array.from({ length: 5 }, (_, at) => doc(`part-${at}.txt`, "€".repeat(50_000)));
  const large = await draft(a, workspaceId, randomUUID(), { documents: full, autoAccept: true });
  assert.deepEqual([large.status, await flag()], [202, true]);
});

test("each refusal of the Draft's body names its field, never a value, and writes nothing; a sixth document is documents_too_many", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const secret = "Corvid's private rate card";
  const one = doc("notes.txt", secret);
  const cases: [object, string[]][] = [
    [{ documents: [] }, ["documents"]],
    [{ documents: [one, doc("faq.md", secret), one] }, ["documents.2.name"]],
    [{ documents: [doc("a/b.txt", secret)] }, ["documents.0.name"]],
    [{ documents: [doc("bad\u0007.txt", secret)] }, ["documents.0.name"]],
    [
      { documents: [doc("deck.doc", secret, { mediaType: "application/msword" })] },
      ["documents.0.mediaType"],
    ],
    [{ documents: [doc("notes.txt", secret, { status: "cut" })] }, ["documents.0.status"]],
    [{ documents: [one, doc("faq.md", secret), doc("c.txt", "")] }, ["documents.2.text"]],
    [{ documents: [doc("c.txt", "x".repeat(50_001))] }, ["documents.0.text"]],
    [{ documents: [doc("c.txt", `${secret}\u0000`)] }, ["documents.0.text"]],
    [
      { documents: [{ name: "c.txt", text: secret }] },
      ["documents.0.mediaType", "documents.0.status"],
    ],
    [{ autoAccept: "yes" }, ["autoAccept"]],
    [{ urls: [secret] }, [""]],
  ];
  for (const [body, fields] of cases) {
    const answer = await draft(a, workspaceId, randomUUID(), body);
    const refusal = { status: 400, body: { code: "validation_failed", details: { fields } } };
    assert.deepEqual({ status: answer.status, body: answer.body }, refusal, JSON.stringify(fields));
    assert.ok(!JSON.stringify(answer.body).includes(secret), "no value in the answer");
  }
  const six = Array.from({ length: 6 }, (_, at) => doc(`${at}.txt`, secret));
  const many = await draft(a, workspaceId, randomUUID(), { documents: six });
  const tooMany = { code: "documents_too_many", details: { files: 5 } };
  assert.deepEqual([many.status, many.body], [400, tooMany], "ONBOARDING_MAX_FILES, five unset");
  const app = asRole("app");
  assert.deepEqual(
    await Promise.all([
      app.companyDocument.count(),
      app.outboxEntry.count({ where: { workspaceId } }),
    ]),
    [0, 0],
  );
});

test("the Draft's body takes 10 MB (draft-body-10mb): 69 full three-byte documents reach the route, which refuses them as documents_too_many; 70 pass 10 MB, 413 payload_too_large before the route runs, and nothing is written", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  await call(a, workspaceId, { ...empty, sourceUrl: "https://acme.test/" });
  const app = asRole("app");
  const where = { workspaceId, eventName: "onboarding.draft_requested" };
  const documents = (count: number) =>
    Array.from({ length: count }, (_, at) => doc(`part-${at}.txt`, "中".repeat(50_000)));
  const bytes = (list: object[]) => Buffer.byteLength(JSON.stringify({ documents: list }));
  const written = () =>
    Promise.all([app.companyDocument.count(), app.outboxEntry.count({ where })]);
  // Five documents are allowed, so the route answers 400 to the 69: the body reader let them by.
  assert.ok(bytes(documents(69)) < 10 * 1024 * 1024);
  const fits = await draft(a, workspaceId, randomUUID(), { documents: documents(69) });
  const tooMany = { code: "documents_too_many", details: { files: 5 } };
  assert.deepEqual([fits.status, fits.body], [400, tooMany], "past 1 MB, under 10 MB");
  assert.ok(bytes(documents(70)) > 10 * 1024 * 1024);
  const over = await draft(a, workspaceId, randomUUID(), { documents: documents(70) });
  assert.deepEqual([over.status, over.body], [413, { code: "payload_too_large" }]);
  assert.deepEqual(await written(), [0, 0], "nothing written");
});

test("every other route keeps 1 MB: a Company Knowledge save just past it is 413 payload_too_large, one just under it is read", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const MB = 1024 * 1024;
  const sized = (bytes: number) => {
    const fixed = Buffer.byteLength(JSON.stringify({ ...empty, oneLiner: "" }));
    return { ...empty, oneLiner: "x".repeat(bytes - fixed) };
  };
  const over = await call(a, workspaceId, sized(MB + 1));
  assert.deepEqual([over.status, over.body], [413, { code: "payload_too_large" }]);
  const under = await call(a, workspaceId, sized(MB));
  assert.equal(under.status, 400, "read in full and refused by its schema, not by the reader");
  assert.equal(under.body.code, "validation_failed");
});

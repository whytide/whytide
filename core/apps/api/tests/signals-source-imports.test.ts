// signals' source imports end to end (sources-csv-import; core/modules/signals/README.md "Importing
// sources"): the host started with identity's guard and the signals module, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP. A CSV file of
// sources is checked, then imported, as the screen sends it: its bytes in base64 in a JSON body, with
// its name and the sender account, a connected account of the workspace written by linkedin's test
// factory. No row has a short link: no request leaves the laptop.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// Two tracked sources per sender account, below the workspace's ten, so that each limit binds on its
// own rows. Set before signals loads: its settings are read once, at import. This file's process only.
process.env.SIGNALS_MAX_TRACKED_PER_ACCOUNT = "2";

// signals, and linkedin's test hooks, by their builds' paths, as src/modules.generated.ts loads them.
const build = new URL("../../../../modules/signals/dist/", import.meta.url);
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const testing: SignalsTesting = await import(new URL("testing/index.js", build).href);
const linkedin: LinkedinTesting = await import(
  new URL("../../linkedin/dist/testing/index.js", build).href
);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
linkedin.useLinkedinClient(asRole("app"));
testing.useSignalsClient(asRole("app"));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "signals", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

type Answer = { status: number; body: any };
const HEADER = "kind,url,name,phrase,roles,label";
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000001";

/** A call to …/signals/sources<path> in the tenant's workspace, as its Owner, from the app. */
async function call(tenant: TestTenant, method: string, path = "", body?: unknown) {
  const cookie = signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
  const headers: Record<string, string> = { cookie, "sec-fetch-site": "same-origin" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const url = new URL(`/v1/workspaces/${tenant.workspace.id}/signals/sources${path}`, api.url);
  const json = body === undefined ? undefined : JSON.stringify(body);
  const res = await fetch(url, { method, headers, body: json });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined } as Answer;
}

/** The body of a file: its name, its bytes in base64 and the sender account. */
const fileOf = (fileName: string, content: string | Buffer, senderAccountId: string) => ({
  fileName,
  file: Buffer.from(content).toString("base64"),
  senderAccountId,
});
const csv = (...rows: string[]) => `${[HEADER, ...rows].join("\n")}\n`;
const check = (tenant: TestTenant, body: unknown) => call(tenant, "POST", "/imports/check", body);
const runImport = (tenant: TestTenant, body: unknown) => call(tenant, "POST", "/imports", body);
const senderOf = async (tenant: TestTenant) =>
  (await linkedin.createConnectedAccount(tenant.workspace.id)).id;
const sourcesOf = async (tenant: TestTenant) => (await call(tenant, "GET")).body.sources;

test("a file with one valid row per kind: the check lists four valid rows and writes nothing; the import creates the four sources, enabled, stored canonical, each naming the import, and records it with its counts", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const file = fileOf(
    "Sources.CSV",
    csv(
      `post,${POST},,,,Launch post`,
      "Creator,https://www.linkedin.com/in/example-creator,,,,",
      "company,https://linkedin.com/company/example-rival/,  Example   Rival ,,,",
      "topic,,,revenue operations,Commenter; author,RevOps",
    ),
    sender,
  );
  const checked = await check(a, file);
  assert.deepEqual(checked, {
    status: 200,
    body: {
      fileName: "Sources.CSV",
      rows: 4,
      valid: [
        { row: 2, kind: "post_engagers", label: "Launch post" },
        { row: 3, kind: "creator_engagement", label: "linkedin.com/in/example-creator" },
        { row: 4, kind: "competitor_engagement", label: "Example Rival" },
        { row: 5, kind: "topic_engagement", label: "RevOps" },
      ],
      errors: [],
    },
  });
  assert.deepEqual(await sourcesOf(a), []);
  assert.equal(await asRole("app").signalSourceImport.count(), 0);

  const imported = await runImport(a, file);
  assert.equal(imported.status, 201);
  const { sourceImport } = imported.body;
  const record = await asRole("app").signalSourceImport.findUniqueOrThrow({
    where: { id: sourceImport.id },
  });
  assert.deepEqual(imported.body, {
    sourceImport: {
      id: record.id,
      fileName: "Sources.CSV",
      createdBy: a.user.id,
      createdAt: record.createdAt.toISOString(),
      created: 4,
      disabled: 0,
      refused: 0,
    },
    errors: [],
  });
  assert.equal(record.workspaceId, a.workspace.id);
  const sources: Answer["body"][] = await sourcesOf(a);
  const from = { id: record.id, fileName: "Sources.CSV" };
  const company = "https://www.linkedin.com/company/example-rival";
  assert.deepEqual(
    sources.map((one) => [one.kind, one.config, one.label, one.enabled, one.senderAccountId]),
    [
      [
        "topic_engagement",
        { phrase: "revenue operations", roles: ["author", "commenter"] },
        "RevOps",
      ],
      [
        "competitor_engagement",
        { companyUrl: company, companyName: "Example Rival" },
        "Example Rival",
      ],
      [
        "creator_engagement",
        { profileUrl: "https://www.linkedin.com/in/example-creator" },
        "linkedin.com/in/example-creator",
      ],
      ["post_engagers", { postUrl: POST }, "Launch post"],
    ].map((shown) => [...shown, true, sender]),
  );
  assert.deepEqual(
    sources.map(({ sourceImport: of }) => of),
    [from, from, from, from],
  );
  assert.deepEqual(await call(a, "GET", "/imports"), {
    status: 200,
    body: { imports: [imported.body.sourceImport] },
  });
});

test("each row error is reported with its row, its code and its columns, and creates nothing: an unknown kind, the own posts, a bad URL, a missing name, a blocked topic, a bad role, a label too long, a repeat of an earlier row and a source the workspace has", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const existing = { kind: "post_engagers", config: { postUrl: POST }, label: "Launch post" };
  assert.equal((await call(a, "POST", "", { ...existing, senderAccountId: sender })).status, 201);
  const file = fileOf(
    "errors.csv",
    csv(
      "job_board,https://www.linkedin.com/in/someone,,,,",
      "my_post_engagement,,,,,",
      "post,https://www.linkedin.com/in/someone,,,,",
      "company,https://www.linkedin.com/company/rival,,,,",
      "topic,,,Mental Health at work,,",
      "topic,,,pipeline review,author;lurker,",
      `creator,https://www.linkedin.com/in/creator-a,,,,${"x".repeat(101)}`,
      "creator,https://www.linkedin.com/in/creator-a,,,,Creator A",
      "CREATOR,https://linkedin.com/in/creator-a/,,,,Creator A again",
      `post,${POST}?utm_source=share,,,,Launch post again`,
    ),
    sender,
  );
  const errors = [
    { row: 2, code: "signal_kind_unknown", columns: ["kind"] },
    { row: 3, code: "signal_kind_unknown", columns: ["kind"] },
    { row: 4, code: "signal_config_invalid", columns: ["url"] },
    { row: 5, code: "signal_config_invalid", columns: ["name"] },
    { row: 6, code: "signal_topic_blocked", columns: ["phrase"] },
    { row: 7, code: "signal_config_invalid", columns: ["roles"] },
    { row: 8, code: "signal_config_invalid", columns: ["label"] },
    { row: 10, code: "duplicate_in_file", columns: [] },
    { row: 11, code: "source_exists", columns: [] },
  ];
  const valid = [{ row: 9, kind: "creator_engagement", label: "Creator A" }];
  assert.deepEqual(await check(a, file), {
    status: 200,
    body: { fileName: "errors.csv", rows: 10, valid, errors },
  });
  assert.equal((await sourcesOf(a)).length, 1);
  assert.equal(await asRole("app").signalSourceImport.count(), 0);

  const imported = await runImport(a, file);
  assert.equal(imported.status, 201);
  assert.deepEqual(imported.body.errors, errors);
  const { created, disabled, refused } = imported.body.sourceImport;
  assert.deepEqual([created, disabled, refused], [1, 0, 9]);
  const labels = (await sourcesOf(a)).map(({ label }: { label: string }) => label);
  assert.deepEqual(labels, ["Creator A", "Launch post"]);
});

test("rows past the limits are created disabled: past the sender account's tracked sources and past the workspace's enabled ones; each enables once another is disabled", async () => {
  const [a] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  for (let n = 1; n <= 8; n++) {
    const config = { postUrl: `${POST.slice(0, -2)}${String(10 + n)}` };
    const body = { kind: "post_engagers", config, label: `Post ${n}`, senderAccountId: sender };
    assert.equal((await call(a, "POST", "", body)).status, 201);
  }
  const file = fileOf(
    "limits.csv",
    csv(
      "creator,https://www.linkedin.com/in/creator-1,,,,Creator 1",
      "creator,https://www.linkedin.com/in/creator-2,,,,Creator 2",
      "creator,https://www.linkedin.com/in/creator-3,,,,Creator 3",
      "topic,,,pipeline review,,Topic 1",
      "topic,,,revenue operations,,Topic 2",
    ),
    sender,
  );
  const imported = await runImport(a, file);
  assert.equal(imported.status, 201);
  const { created, disabled, refused } = imported.body.sourceImport;
  assert.deepEqual([created, disabled, refused, imported.body.errors], [5, 3, 0, []]);
  const sources: Answer["body"][] = await sourcesOf(a);
  const byLabel = new Map(sources.map((source) => [source.label, source]));
  const enabledOf = (label: string) => byLabel.get(label)?.enabled;
  assert.deepEqual(["Creator 1", "Creator 2", "Creator 3", "Topic 1", "Topic 2"].map(enabledOf), [
    true,
    true,
    false,
    false,
    false,
  ]);
  const third = byLabel.get("Creator 3")?.id;
  assert.deepEqual(await call(a, "PATCH", `/${third}`, { enabled: true }), {
    status: 400,
    body: { code: "signal_tracked_limit", details: { limit: 2 } },
  });
  const first = byLabel.get("Creator 1")?.id;
  assert.equal((await call(a, "PATCH", `/${first}`, { enabled: false })).status, 200);
  const enabled = await call(a, "PATCH", `/${third}`, { enabled: true });
  assert.deepEqual([enabled.status, enabled.body.enabled], [200, true]);
  assert.deepEqual(await call(a, "PATCH", `/${byLabel.get("Topic 1")?.id}`, { enabled: true }), {
    status: 400,
    body: { code: "signal_sources_limit", details: { limit: 10 } },
  });
});

test("a file that is not CSV, not UTF-8, without a kind column, with too many rows or too large, and another workspace's sender account are refused whole by the check and the import; nothing is written", async () => {
  const [a, b] = await createTwoWorkspaces();
  const sender = await senderOf(a);
  const refused = (code: string, status = 400) => ({ status, body: { code } });
  const row = (n: number) => `topic,,,phrase ${n},,`;
  const cases: [body: unknown, answer: unknown][] = [
    [fileOf("sources.xlsx", csv(row(1)), sender), refused("signal_import_unsupported_type")],
    [fileOf("sources.csv", "PK\x03\x04 a zip", sender), refused("signal_import_unsupported_type")],
    [
      fileOf("sources.csv", `${HEADER}\ntopic,"open,,,,\n`, sender),
      refused("signal_import_unsupported_type"),
    ],
    [
      fileOf("sources.csv", Buffer.from(`${HEADER}\ntopic,,,caf\xe9,,\n`, "latin1"), sender),
      refused("signal_import_bad_encoding"),
    ],
    [fileOf("sources.csv", "url,label\nx,y\n", sender), refused("signal_import_missing_column")],
    [
      fileOf("sources.csv", csv(...Array.from({ length: 201 }, (_, n) => row(n))), sender),
      refused("signal_import_too_many_rows"),
    ],
    [
      fileOf("sources.csv", `${csv(row(1))}${" ".repeat(1_048_576)}`, sender),
      refused("signal_import_too_large", 413),
    ],
  ];
  for (const [body, answer] of cases) {
    assert.deepEqual(await check(a, body), answer);
    assert.deepEqual(await runImport(a, body), answer);
  }
  const foreign = fileOf("sources.csv", csv(row(1)), await senderOf(b));
  const invalid = {
    status: 400,
    body: { code: "signal_sender_account_invalid", details: { fields: ["senderAccountId"] } },
  };
  assert.deepEqual(await check(a, foreign), invalid);
  assert.deepEqual(await runImport(a, foreign), invalid);
  assert.deepEqual(await sourcesOf(a), []);
  assert.equal(await asRole("app").signalSourceImport.count(), 0);
});

test("tenancy: another workspace sees neither the import nor its sources, and its own sources are no repeat of them", async () => {
  const [a, b] = await createTwoWorkspaces();
  const file = (sender: string) =>
    fileOf("shared.csv", csv("creator,https://www.linkedin.com/in/creator-a,,,,Creator A"), sender);
  const imported = await runImport(a, file(await senderOf(a)));
  assert.equal(imported.body.sourceImport.created, 1);
  assert.deepEqual(await call(b, "GET", "/imports"), { status: 200, body: { imports: [] } });
  assert.deepEqual(await sourcesOf(b), []);
  const own = await check(b, file(await senderOf(b)));
  assert.deepEqual([own.body.valid.length, own.body.errors], [1, []]);
  assert.equal((await call(a, "GET", "/imports")).body.imports.length, 1);
});

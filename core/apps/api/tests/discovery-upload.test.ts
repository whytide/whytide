// discovery's upload end to end (alpha-p5-030; core/modules/discovery/README.md "Routes"): the host
// started with the identity and discovery modules, on the fake authentication adapter, in a schema of
// the worktree's database, the files port on the slice's MinIO (PROVIDER_FILES=s3), contacts'
// hashes on a fixed test salt, answering real HTTP. It lives here: a module never imports a host.
// Made-up profile URLs only.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { type IncomingMessage, request } from "node:http";
import { resolve } from "node:path";
import { text } from "node:stream/consumers";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type HashKind, recordHash } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { type Api, start } from "../src/start.ts";

// discovery by its build's path, as src/modules.generated.ts loads it: the api does not list a
// module with a screen (core/apps/web/docs/screens.md).
const build = new URL("../../../../modules/discovery/dist/", import.meta.url);
type DiscoveryTesting = typeof import("../../../modules/discovery/dist/testing/index.js");
const testing: DiscoveryTesting = await import(new URL("testing/index.js", build).href);
const { useDiscoveryClient } = testing;

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useDiscoveryClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
const modules: ModuleLoader[] = [
  { name: "identity", load: () => import("@whytide/identity") },
  { name: "discovery", load: () => import(new URL("index.js", build).href) },
];
const fixtures = resolve(import.meta.dirname, "..", "..", "tests", "fixtures", "discovery");
const BOUNDARY = "whytide-upload-test";
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
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

const cookieOf = ({ user }: TestTenant) =>
  signInAs(user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
const imports = ({ workspace }: TestTenant) => `/v1/workspaces/${workspace.id}/discovery/imports`;
/** The multipart body's pieces: its head, the file, in one piece or several, and its end. */
const form = (file: Buffer | readonly Buffer[], name = "people.csv") => [
  Buffer.from(
    `--${BOUNDARY}\r\ncontent-disposition: form-data; name="file"; filename="${name}"\r\n` +
      "content-type: text/csv\r\n\r\n",
  ),
  ...(Buffer.isBuffer(file) ? [file] : file),
  TAIL,
];
/** A header and `count` rows of made-up profile URLs. */
const rows = (count: number, from = 1) =>
  Array.from(
    { length: count },
    (_, i) => `https://www.linkedin.com/in/example-person-${from + i},E\n`,
  );
const csv = (count: number) => Buffer.from(["linkedin_url,name\n", ...rows(count)].join(""));

/**
 * POSTs the pieces as the member, each once the socket took the last and `pause(index)` ms after it
 * unless the answer came; resolves with the answer and the bytes that went before it. A refusal
 * closes the connection: writing may fail then.
 */
function upload(tenant: TestTenant, pieces: readonly Buffer[], pause = (_index: number) => 0) {
  return new Promise<{ status: number; body: any; sent: number }>((done, fail) => {
    const length = pieces.reduce((sum, piece) => sum + piece.length, 0);
    const req = request(new URL(imports(tenant), api.url), {
      method: "POST",
      headers: {
        cookie: cookieOf(tenant),
        "sec-fetch-site": "same-origin",
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(length),
      },
    });
    let sent = 0;
    let answered = false;
    let answer = () => {};
    const responded = new Promise<void>((settle) => {
      answer = settle;
    });
    req.on("response", async (res: IncomingMessage) => {
      answered = true;
      answer();
      const body = await text(res);
      done({ status: res.statusCode ?? 0, body: body ? JSON.parse(body) : undefined, sent });
    });
    req.on("error", (error) => setTimeout(() => answered || fail(error), 200));
    (async () => {
      for (const [index, piece] of pieces.entries()) {
        if (answered || req.destroyed) return;
        sent += piece.length;
        if (!req.write(piece)) await Promise.race([once(req, "drain"), responded]);
        const wait = pause(index);
        if (wait > 0) await Promise.race([sleep(wait, undefined, { ref: false }), responded]);
      }
      if (!answered) req.end();
    })().catch(() => undefined);
  });
}

async function get(tenant: TestTenant, path = "") {
  const res = await fetch(new URL(imports(tenant) + path, api.url), {
    headers: { cookie: cookieOf(tenant) },
  });
  return { status: res.status, body: (await res.json()) as unknown };
}

test("a 50-row file with three bad URLs and a duplicate: 50 rows, 46 valid, the report names rows and codes", async () => {
  const [a] = await createTwoWorkspaces();
  const file = readFileSync(resolve(fixtures, "fifty-rows.csv"));
  const created = await upload(a, form(file, "fifty-rows.csv"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id, createdAt, ...job } = created.body;
  assert.match(id, /^job_[0-9A-Z]{26}$/);
  assert.deepEqual(job, {
    fileName: "fifty-rows.csv",
    status: "validated",
    rowCount: 50,
    validCount: 46,
    errorCount: 4,
    errors: [
      { row: 8, code: "url_invalid" },
      { row: 20, code: "url_not_linkedin" },
      { row: 34, code: "url_not_linkedin" },
      { row: 42, code: "duplicate_in_file" },
    ],
    counts: null,
    failure: null,
    createdBy: a.user.id,
    startedAt: null,
    finishedAt: null,
  });
  assert.deepEqual(await get(a, `/${id}`), { status: 200, body: created.body });
  assert.deepEqual(await get(a), { status: 200, body: { jobs: [created.body] } });
});

test("past 5,000 rows is 400 import_too_many_rows, read no further; 6 MB is 413; an .xlsx renamed .csv is 400", async () => {
  const [a] = await createTwoWorkspaces();
  const refused = (code: string) => ({ status: 400, body: { code } });
  const plain = await upload(a, form(csv(5_001)));
  assert.deepEqual({ status: plain.status, body: plain.body }, refused("import_too_many_rows"));

  // 10,000 rows served slowly, 100 a piece, 2 ms apart, then 5 s after the piece with row 5,001:
  // the answer comes in that pause, and the rest of the file never goes.
  const header = Buffer.from("linkedin_url,name\n");
  const hundreds = Array.from({ length: 100 }, (_, i) =>
    Buffer.from(rows(100, i * 100 + 1).join("")),
  );
  const pieces = form([header, ...hundreds]);
  const at5001 = pieces.indexOf(hundreds[50] ?? header);
  const through5001 = pieces.slice(0, at5001 + 1).reduce((sum, piece) => sum + piece.length, 0);
  const slow = await upload(a, pieces, (index) => (index === at5001 ? 5_000 : 2));
  assert.deepEqual({ status: slow.status, body: slow.body }, refused("import_too_many_rows"));
  assert.equal(slow.sent, through5001, "the bytes through row 5,001's piece, and no more");

  const wide = (n: number) =>
    `https://www.linkedin.com/in/example-person-${n},${"x".repeat(60_000)}\n`;
  const large = Buffer.from(
    ["linkedin_url,notes\n", ...Array.from({ length: 105 }, (_, n) => wide(n))].join(""),
  );
  assert.ok(large.length > 6_000_000);
  const tooLarge = await upload(a, form(large));
  assert.deepEqual(
    { status: tooLarge.status, body: tooLarge.body },
    { status: 413, body: { code: "import_too_large" } },
  );

  const xlsx = Buffer.concat([
    Buffer.from("PK\x03\x04\x14\x00\x06\x00", "latin1"),
    Buffer.from("[Content_Types].xml"),
  ]);
  const renamed = await upload(a, form(xlsx, "people.csv"));
  assert.deepEqual(
    { status: renamed.status, body: renamed.body },
    refused("import_unsupported_type"),
  );
  assert.deepEqual(await get(a), { status: 200, body: { jobs: [] } }, "no job for a refused file");
});

test("a cell starting with =SUM( is stored as it came and reported as text", async () => {
  const [a] = await createTwoWorkspaces();
  const file = Buffer.from(
    'linkedin_url,name,company\n"=SUM(1,2)",Example Person 1,Example Company 1\n' +
      "https://www.linkedin.com/in/example-person-2,=SUM(A1:A9),Example Company 2\n",
  );
  const created = await upload(a, form(file));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { rowCount, validCount, errors } = created.body;
  assert.deepEqual(
    { rowCount, validCount, errors },
    {
      rowCount: 2,
      validCount: 1,
      errors: [{ row: 2, code: "url_invalid" }],
    },
  );
  const row = await asRole("app").importJob.findUniqueOrThrow({ where: { id: created.body.id } });
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  const stored = await files.get({ workspaceId: a.workspace.id, key: row.fileKey });
  assert.equal(stored.contentType, "text/csv; charset=utf-8");
  assert.deepEqual(Buffer.concat(await stored.body.toArray()), file);
});

test("a row whose person was erased from the workspace is person_erased; a rejected candidate's is not", async () => {
  const [a, b] = await createTwoWorkspaces();
  const hash = ({ workspace }: TestTenant, slug: string, kind: HashKind) =>
    withTenant(
      { workspaceId: workspace.id, principal: servicePrincipal("discovery_test") },
      () => recordHash({ linkedinUrl: `https://linkedin.com/in/${slug}`, kind }),
      { client: asRole("app") },
    );
  await hash(a, "example-person-2", "erased");
  await hash(a, "example-person-3", "rejected_candidate");
  await hash(b, "example-person-1", "erased");
  const created = await upload(a, form(csv(3)));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { rowCount, validCount, errors } = created.body;
  assert.deepEqual(
    { rowCount, validCount, errors },
    { rowCount: 3, validCount: 2, errors: [{ row: 3, code: "person_erased" }] },
  );
});

test("the file is under w/<workspace>/imports/; another workspace neither reads nor lists the job", async () => {
  const [a, b] = await createTwoWorkspaces();
  const created = await upload(a, form(csv(3)));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { id } = created.body;
  const row = await asRole("app").importJob.findUniqueOrThrow({ where: { id } });
  assert.equal(row.fileKey, `w/${a.workspace.id}/imports/${id}.csv`);
  assert.equal(row.createdBy, a.user.id);
  assert.deepEqual(await get(b, `/${id}`), { status: 404, body: { code: "import_not_found" } });
  assert.deepEqual(await get(b), { status: 200, body: { jobs: [] } });
});

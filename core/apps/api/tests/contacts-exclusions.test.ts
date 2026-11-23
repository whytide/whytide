// contacts' exclusion lists end to end (gamma-p2-045; core/modules/contacts/README.md "Routes"): the
// host started with identity, whose resolver guards the workspace, and contacts, on the fake
// authentication adapter, in a schema of the worktree's database, answering real HTTP: an upload,
// each refusal, the 413 with the connection closed and the rest unread, a formula cell, the
// duplicates within a file and across two imports, the lists page, a removal, another workspace's
// list, and each handler's permission. The limits are the defaults: the test sets neither. It lives
// here: a module never imports a host. Made-up domains only.
import assert from "node:assert/strict";
import { once } from "node:events";
import { type IncomingMessage, request } from "node:http";
import { text } from "node:stream/consumers";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { useContactsClient, useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, registeredPermissions } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");
// The exclusions controller by its build's path, as contacts-suppression.test.ts reads its handlers'
// permissions; the same build the host loads.
type Controllers = typeof import("../../../modules/contacts/dist/api/exclusions.controller.js");
const { ExclusionsController }: Controllers = await import(
  new URL("../../../../modules/contacts/dist/api/exclusions.controller.js", import.meta.url).href
);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
// The upload's own run, in this file's schema too.
useContactsClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
const logs = collectLogs();
/** EXCLUSIONS_IMPORT_MAX_BYTES's default; the body may hold twice as many. */
const MAX_BYTES = 1_048_576;
const BOUNDARY = "whytide-exclusions-test";
const TAIL = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: logs.destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

const cookieOf = (userId: string) =>
  signInAs(userId)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
const exclusions = ({ workspace }: TestTenant) =>
  `/v1/workspaces/${workspace.id}/contacts/exclusions`;
/** A part's head: a file's when `filename` is given, a field's otherwise. */
const partHead = (name: string, filename?: string) =>
  Buffer.from(
    `--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"` +
      (filename === undefined
        ? "\r\n\r\n"
        : `; filename="${filename}"\r\ncontent-type: text/csv\r\n\r\n`),
  );
/** The multipart body's pieces: the file's head, the file in one piece or several, and its end. */
const form = (file: string | Buffer | readonly Buffer[], name = "customers.csv") => [
  partHead("file", name),
  ...(typeof file === "string" ? [Buffer.from(file)] : Buffer.isBuffer(file) ? [file] : file),
  TAIL,
];
const sizeOf = (pieces: readonly Buffer[]) => pieces.reduce((sum, piece) => sum + piece.length, 0);

type Upload = { status: number; body: any; sent: number; connection: string | undefined };
type UploadOptions = {
  /** `?relationship=customer` unless given. */
  readonly query?: string;
  /** The tenant's Owner unless given. */
  readonly userId?: string;
  /** The ms to wait after the piece at `index`, unless the answer came. */
  readonly pause?: (index: number) => number;
};
/**
 * POSTs the pieces to …/exclusions/imports, each once the socket took the last; resolves with the
 * answer, its Connection header, and the bytes that went before it. A refusal closes the connection:
 * writing may fail then.
 */
function upload(tenant: TestTenant, pieces: readonly Buffer[], options: UploadOptions = {}) {
  const { query = "?relationship=customer", userId = tenant.user.id, pause = () => 0 } = options;
  return new Promise<Upload>((done, fail) => {
    const req = request(new URL(`${exclusions(tenant)}/imports${query}`, api.url), {
      method: "POST",
      headers: {
        cookie: cookieOf(userId),
        origin: APP_ORIGIN,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "content-length": String(sizeOf(pieces)),
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
      const status = res.statusCode ?? 0;
      const { connection } = res.headers;
      done({ status, body: body ? JSON.parse(body) : undefined, sent, connection });
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
const outcome = ({ status, body }: Upload) => ({ status, body });

/** A GET, a DELETE, or a POST of JSON, to …/exclusions<path> from the app, as the Owner by default. */
async function call(
  tenant: TestTenant,
  method: string,
  path: string,
  options: { userId?: string; json?: unknown } = {},
) {
  const headers: Record<string, string> = {
    cookie: cookieOf(options.userId ?? tenant.user.id),
    origin: APP_ORIGIN,
  };
  if (options.json !== undefined) headers["content-type"] = "application/json";
  const body = options.json === undefined ? undefined : JSON.stringify(options.json);
  const res = await fetch(new URL(exclusions(tenant) + path, api.url), { method, headers, body });
  const raw = await res.text();
  return { status: res.status, body: raw ? JSON.parse(raw) : undefined };
}
const lists = (tenant: TestTenant, query = "", userId?: string) =>
  call(tenant, "GET", `/lists${query}`, { userId });
const removal = (tenant: TestTenant, listId: string, userId?: string) =>
  call(tenant, "DELETE", `/lists/${listId}`, { userId });

/** What the workspace stores of exclusion lists: its lists, its entries and their events. */
async function stored({ workspace }: TestTenant) {
  const app = asRole("app");
  const workspaceId = workspace.id;
  const eventName = "contacts.suppression_added";
  return {
    lists: await app.exclusionList.count({ where: { workspaceId } }),
    entries: await app.suppressionEntry.count({ where: { workspaceId } }),
    events: await app.outboxEntry.count({ where: { workspaceId, eventName } }),
  };
}
const NOTHING = { lists: 0, entries: 0, events: 0 };

test("POST …/imports?relationship=customer: 201 with the list named after the file, what it added, its duplicates and its rows without an entry by record number and code; each entry the uploader's csv customer entry on every channel, with the list; GET …/lists answers the list; one contacts.suppression_added with its id; a formula cell is a row number and a code, in no answer, log line, entry or event", async () => {
  const [a] = await createTwoWorkspaces();
  const file =
    "Company,Domain\r\n" +
    "Harbor,harbor.example\r\n" +
    "Harbor EU,https://eu.harbor.example/\r\n" +
    'Formula,"=HYPERLINK(""https://formula-cell.example"",""open"")"\r\n' +
    "Mail,ops@mail-cell.example\r\n" +
    "Harbor again,www.harbor.example\r\n" +
    "Quay,+quay-formula.example\r\n" +
    "Quay,quay.example\r\n";
  const created = await upload(a, form(file, "q4-customers.csv"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { list, ...counts } = created.body;
  assert.match(list.id, /^exl_[0-9A-Z]{26}$/);
  assert.ok(Math.abs(Date.parse(list.createdAt) - Date.now()) < 60_000);
  assert.deepEqual(
    { ...list, id: undefined, createdAt: undefined },
    {
      id: undefined,
      name: "q4-customers.csv",
      relationship: "customer",
      entryCount: 3,
      duplicateCount: 1,
      invalidCount: 3,
      createdBy: a.user.id,
      createdAt: undefined,
      removedAt: null,
      removedBy: null,
    },
  );
  assert.deepEqual(counts, {
    added: 3,
    duplicates: 1,
    invalid: [
      { row: 4, code: "domain_invalid" },
      { row: 5, code: "domain_invalid" },
      { row: 6, code: "duplicate" },
      { row: 7, code: "domain_invalid" },
    ],
  });

  const app = asRole("app");
  const workspaceId = a.workspace.id;
  const entries = await app.suppressionEntry.findMany({
    where: { workspaceId },
    orderBy: { domain: "asc" },
  });
  const domains = entries.map(({ domain }) => domain);
  assert.deepEqual(domains, ["eu.harbor.example", "harbor.example", "quay.example"]);
  for (const entry of entries) {
    const { layer, matchType, channel, relationship, source, createdBy, exclusionListId } = entry;
    assert.deepEqual(
      [layer, matchType, channel, relationship, source, createdBy, exclusionListId],
      ["relationship", "domain", "all", "customer", "csv", a.user.id, list.id],
    );
  }
  assert.deepEqual(await lists(a), { status: 200, body: { lists: [list], nextCursor: null } });
  const events = await app.outboxEntry.findMany({
    where: { workspaceId, eventName: "contacts.suppression_added" },
  });
  assert.deepEqual(
    events.map(({ payload }) => payload),
    [
      {
        suppressionId: entries.map(({ id }) => id).sort()[0],
        layer: "relationship",
        channel: "all",
        listId: list.id,
      },
    ],
  );

  const cells = /formula-cell|HYPERLINK|quay-formula|mail-cell/;
  assert.doesNotMatch(JSON.stringify(created.body), cells);
  assert.doesNotMatch(JSON.stringify(events.map(({ payload }) => payload)), cells);
  assert.ok(!logs.raw.some((line) => cells.test(line)), "no cell in a log line");
});

test("duplicates within a file and across two imports: a domain twice in a file is one entry and a duplicate row; a domain an active entry of either list holds is a duplicate of the second import, which adds the rest; a file of duplicates only makes a list of no entry and no event", async () => {
  const [a] = await createTwoWorkspaces();
  const first = await upload(a, form("domain\nacme.example\nbeta.example\nACME.example\n"));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(
    { added: first.body.added, duplicates: first.body.duplicates, invalid: first.body.invalid },
    { added: 2, duplicates: 1, invalid: [{ row: 4, code: "duplicate" }] },
  );

  const rivals = form("domain\nbeta.example\ngamma.example\nbeta.example\n", "rivals.csv");
  const second = await upload(a, rivals, { query: "?relationship=competitor" });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  const { list, ...counts } = second.body;
  const duplicate = (row: number) => ({ row, code: "duplicate" });
  assert.deepEqual(counts, { added: 1, duplicates: 2, invalid: [duplicate(2), duplicate(4)] });
  assert.deepEqual(
    [list.name, list.relationship, list.entryCount, list.duplicateCount, list.invalidCount],
    ["rivals.csv", "competitor", 1, 2, 0],
  );

  const third = (await upload(a, form("domain\nacme.example\ngamma.example\n"))).body;
  assert.deepEqual([third.added, third.duplicates, third.list.entryCount], [0, 2, 0]);
  assert.deepEqual(await stored(a), { lists: 3, entries: 3, events: 2 });
});

test("each refusal answers its code and stores nothing: not multipart, a field, a second part, no .csv name, a ZIP signature, a NUL byte, invalid UTF-8, a malformed CSV, no domain column, no valid row, a relationship off the list", async () => {
  const [a] = await createTwoWorkspaces();
  const refused = (code: string) => ({ status: 400, body: { code } });
  const csv = "domain\nrefused.example\n";
  const field = Buffer.from(
    `--${BOUNDARY}\r\ncontent-disposition: form-data; name="note"\r\n\r\nhello\r\n`,
  );
  const twoFiles = [
    partHead("file", "customers.csv"),
    Buffer.from(`${csv}\r\n`),
    ...form("domain\nsecond-part.example\n", "more.csv"),
  ];
  const zip = Buffer.concat([
    Buffer.from("PK\x03\x04\x14\x00\x06\x00", "latin1"),
    Buffer.from("[Content_Types].xml"),
  ]);
  const cases: [string, readonly Buffer[], string][] = [
    ["a field", [field, ...form(csv)], "exclusions_unsupported_type"],
    ["a second part", twoFiles, "exclusions_unsupported_type"],
    ["no .csv name", form(csv, "customers.txt"), "exclusions_unsupported_type"],
    ["an .xlsx renamed .csv", form(zip), "exclusions_unsupported_type"],
    ["a NUL byte", form("domain\nnul\u0000.example\n"), "exclusions_unsupported_type"],
    [
      "invalid UTF-8",
      form(Buffer.concat([Buffer.from("domain\n"), Buffer.from([0xc3, 0x28]), Buffer.from("\n")])),
      "exclusions_bad_encoding",
    ],
    ["an unclosed quote", form('domain\n"refused.example\n'), "exclusions_unsupported_type"],
    ["a row of another width", form("domain\nrefused.example,1\n"), "exclusions_unsupported_type"],
    ["no domain column", form("website\nrefused.example\n"), "exclusions_missing_column"],
    ["an empty file", form(""), "exclusions_missing_column"],
    ["a header only", form("domain\n"), "exclusions_no_valid_row"],
    ["no valid row", form("domain\n=1+1\nops@refused.example\n"), "exclusions_no_valid_row"],
  ];
  for (const [name, pieces, code] of cases) {
    assert.deepEqual(outcome(await upload(a, pieces)), refused(code), name);
  }

  assert.deepEqual(
    await call(a, "POST", "/imports?relationship=customer", { json: { domain: "a.example" } }),
    refused("exclusions_unsupported_type"),
    "a JSON body",
  );
  assert.deepEqual(
    await call(a, "POST", "/imports?relationship=customer"),
    refused("exclusions_unsupported_type"),
    "no body",
  );
  for (const query of ["", "?relationship=partner", "?relationship=customer&extra=1"]) {
    const answer = await upload(a, form(csv), { query });
    assert.deepEqual([answer.status, answer.body.code], [400, "validation_failed"], query);
  }
  assert.deepEqual(await stored(a), NOTHING);
  assert.deepEqual(await lists(a), { status: 200, body: { lists: [], nextCursor: null } });
  assert.ok(!logs.raw.some((line) => line.includes("refused.example")), "no cell in a log line");
});

test("a file past the limits is refused as soon as it passes them, the connection closed and the rest unread: row 5,001 is 400 exclusions_too_many_rows; the byte past 1 MiB is 413 exclusions_too_large; a body declared over 2 MiB is the host's 413 payload_too_large at once", async () => {
  const [a] = await createTwoWorkspaces();
  // 10,000 rows, 100 a piece, 2 ms apart, then 5 s after the piece with row 5,001: the answer comes
  // in that pause, and the rest of the file never goes.
  const header = Buffer.from("domain\n");
  const hundreds = Array.from({ length: 100 }, (_, piece) =>
    Buffer.from(
      Array.from({ length: 100 }, (_, row) => `company-${piece * 100 + row + 1}.example\n`).join(
        "",
      ),
    ),
  );
  const rows = form([header, ...hundreds]);
  const at5001 = rows.indexOf(hundreds[50] ?? header);
  const manyRows = await upload(a, rows, { pause: (index) => (index === at5001 ? 5_000 : 2) });
  assert.deepEqual(outcome(manyRows), { status: 400, body: { code: "exclusions_too_many_rows" } });
  assert.equal(manyRows.sent, sizeOf(rows.slice(0, at5001 + 1)), "through row 5,001's piece");
  assert.equal(manyRows.connection, "close");

  // 25 rows of 60,000 bytes, about 1.5 MB, a row a piece, then 5 s after the one past 1 MiB.
  const wide = Array.from({ length: 25 }, (_, n) =>
    Buffer.from(`wide-${n}.example,${"x".repeat(60_000)}\n`),
  );
  const large = form([Buffer.from("domain,notes\n"), ...wide]);
  const past = large.findIndex((_, index) => sizeOf(large.slice(1, index + 1)) > MAX_BYTES);
  assert.ok(past > 1 && sizeOf(large) < 2 * MAX_BYTES);
  const tooLarge = await upload(a, large, { pause: (index) => (index === past ? 5_000 : 2) });
  assert.deepEqual(outcome(tooLarge), { status: 413, body: { code: "exclusions_too_large" } });
  assert.equal(tooLarge.sent, sizeOf(large.slice(0, past + 1)), "through the piece past 1 MiB");
  assert.equal(tooLarge.connection, "close");

  const over = form([Buffer.from("domain,notes\n"), ...wide, ...wide]);
  assert.ok(sizeOf(over) > 2 * MAX_BYTES);
  const declared = await upload(a, over);
  assert.deepEqual(outcome(declared), { status: 413, body: { code: "payload_too_large" } });
  assert.equal(declared.connection, "close");
  assert.deepEqual(await stored(a), NOTHING);
});

test("GET …/lists pages the lists newest first; DELETE …/lists/{listId} is 204 and ends the list and its entries, the remover's id kept, the other lists' entries held; a second removal and an unknown list are 404 exclusion_list_not_found", async () => {
  const [a] = await createTwoWorkspaces();
  const names = ["one.csv", "two.csv", "three.csv"];
  const made: Upload["body"][] = [];
  for (const [n, name] of names.entries()) {
    const created = await upload(a, form(`domain\npage-${n}.example\npage-${n}-b.example\n`, name));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    made.push(created.body.list);
  }
  const [one, two, three] = made;
  const firstPage = await lists(a, "?limit=2");
  assert.deepEqual(firstPage, { status: 200, body: { lists: [three, two], nextCursor: two.id } });
  const secondPage = await lists(a, `?limit=2&cursor=${two.id}`);
  assert.deepEqual(secondPage, { status: 200, body: { lists: [one], nextCursor: null } });

  assert.deepEqual(await removal(a, two.id), { status: 204, body: undefined });
  const app = asRole("app");
  const entries = await app.suppressionEntry.findMany({ where: { exclusionListId: two.id } });
  assert.deepEqual(
    entries.map(({ removedBy }) => removedBy),
    [a.user.id, a.user.id],
  );
  const listed = (await lists(a)).body.lists;
  assert.deepEqual(
    listed.map(({ id, removedBy }: { id: string; removedBy: string | null }) => [id, removedBy]),
    [
      [three.id, null],
      [two.id, a.user.id],
      [one.id, null],
    ],
  );
  assert.ok(Math.abs(Date.parse(listed[1].removedAt) - Date.now()) < 60_000);
  const active = await app.suppressionEntry.count({
    where: { workspaceId: a.workspace.id, removedAt: null },
  });
  assert.equal(active, 4, "the other lists' entries hold");

  const notFound = { status: 404, body: { code: "exclusion_list_not_found" } };
  assert.deepEqual(await removal(a, two.id), notFound);
  assert.deepEqual(await removal(a, `exl_${"0".repeat(26)}`), notFound);
});

test("another workspace's list is no list of this one: B lists none and its removal is 404 exclusion_list_not_found; A's list holds", async () => {
  const [a, b] = await createTwoWorkspaces();
  const created = await upload(a, form("domain\ntheirs.example\n"));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { list } = created.body;
  assert.deepEqual(await lists(b), { status: 200, body: { lists: [], nextCursor: null } });
  assert.deepEqual(await removal(b, list.id), {
    status: 404,
    body: { code: "exclusion_list_not_found" },
  });
  assert.deepEqual(await lists(a), { status: 200, body: { lists: [list], nextCursor: null } });
  assert.deepEqual(await stored(b), NOTHING);
});

test("each handler declares its permission: the upload suppression.write, the lists suppression.read, the removal suppression.remove; a Member uploads and lists, and is 403 forbidden on a removal; a user of no membership is 403 on the three routes", async () => {
  const permission = (handler: "upload" | "lists" | "remove") =>
    Reflect.getMetadata("whytide:permission", ExclusionsController.prototype[handler]);
  assert.deepEqual(
    [permission("upload"), permission("lists"), permission("remove")],
    ["suppression.write", "suppression.read", "suppression.remove"],
  );
  const roles = (action: string) => registeredPermissions().get(action)?.roles;
  assert.deepEqual(roles("suppression.write"), ["Owner", "Admin", "Member"]);
  assert.deepEqual(roles("suppression.read"), ["Owner", "Admin", "Member"]);
  assert.deepEqual(roles("suppression.remove"), ["Owner", "Admin"]);

  const [a] = await createTwoWorkspaces();
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId: a.workspace.id, role: "Member" });
  const asMember = { userId: member.id };
  const created = await upload(a, form("domain\nmembers.example\n"), asMember);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { list } = created.body;
  assert.equal(list.createdBy, member.id);
  assert.deepEqual(await lists(a, "", member.id), {
    status: 200,
    body: { lists: [list], nextCursor: null },
  });
  const forbidden = { status: 403, body: { code: "forbidden" } };
  assert.deepEqual(await removal(a, list.id, member.id), forbidden);

  const nobody = await createUser();
  const asNobody = { userId: nobody.id };
  assert.deepEqual(outcome(await upload(a, form("domain\nnobody.example\n"), asNobody)), forbidden);
  assert.deepEqual(await lists(a, "", nobody.id), forbidden);
  assert.deepEqual(await removal(a, list.id, nobody.id), forbidden);
  assert.deepEqual(await removal(a, list.id), { status: 204, body: undefined });
  assert.deepEqual(await stored(a), { lists: 1, entries: 1, events: 1 });
});

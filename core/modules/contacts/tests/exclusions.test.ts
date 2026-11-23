// contacts' exclusion lists (gamma-p2-045) on the worktree's database, in this file's schema, each
// command inside a tenant run as the route makes one: the cell rules, the reader's rows, the leads an
// import moves, its queries per chunk, the lists, and a removal; review-gaps: the domains each list
// names, the migration's fill of the older lists', and an import and a removal serialized. The
// safety cases are
// tests/safety/suppression.test.ts; the routes' test, the import's entries, duplicates and event
// among them, is the api host's, core/apps/api/tests/contacts-exclusions.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type PrismaClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { linkPersonToCompany, upsertCompany } from "../domain/companies.ts";
import { IMPORT_CHUNK, IMPORT_RUN_TIMEOUT_MS } from "../domain/exclusions/constants.ts";
import { readExclusionFile } from "../domain/exclusions/csv.ts";
import {
  importExclusionList,
  listExclusionLists,
  removeExclusionList,
} from "../domain/exclusions/lists.ts";
import { domainOfCell } from "../domain/exclusions/rows.ts";
import { createLeadForPerson } from "../domain/leads.ts";
import { upsertPersonFromSource } from "../domain/persons.ts";
import { removeSuppression } from "../domain/suppression/entries.ts";
import { domainTarget } from "../domain/suppression/matching.ts";
import { useHashSalt } from "../testing/index.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
const WORKSPACE = "wsp_contacts_exclusions";
const principal = servicePrincipal("contacts_test");
const run = <T>(fn: () => Promise<T>, client: PrismaClient = asRole("app"), timeout?: number) =>
  withTenant({ workspaceId: WORKSPACE, principal }, fn, { client, timeout });
const USER = "usr_exclusions_tester";
const LIMITS = { maxBytes: 1_048_576, maxRows: 10_000 };

const fileOf = (text: string) => readExclusionFile(Readable.from([Buffer.from(text)]), LIMITS);
/** A file of one `domain` column with the cells given, a line each. */
const csv = (...cells: readonly string[]) => ["domain", ...cells].join("\n");
async function importing(
  text: string,
  relationship: "customer" | "competitor" = "customer",
  client?: PrismaClient,
) {
  const file = await fileOf(text);
  const input = { name: "customers.csv", relationship, createdBy: USER, file };
  // The route's run: an import may take longer than a request's 5 s.
  return run(() => importExclusionList(input), client, IMPORT_RUN_TIMEOUT_MS);
}
const app = () => asRole("app");
/** A person of the workspace with a lead, at a company with the domain given; its id. */
async function leadAt(slug: string, domain: string) {
  return run(async () => {
    const profile = { linkedinUrl: `https://linkedin.com/in/${slug}`, firstName: "Ines" };
    const { person } = await upsertPersonFromSource({ source: "import", provider: "csv", profile });
    const company = { name: `Company of ${slug}`, domain };
    const { company: row } = await upsertCompany({ source: "import", provider: "csv", company });
    await linkPersonToCompany({ personId: person.id, companyId: row.id });
    await createLeadForPerson({ personId: person.id, source: { kind: "imported", ref: "imp_1" } });
    return person.id;
  });
}

test("a cell is a domain as contacts normalizes a company's, or none: a formula, an email, a path, a query, a fragment, a port, credentials, one label or LinkedIn", () => {
  const domains = {
    "acme.example": "acme.example",
    "  ACME.Example  ": "acme.example",
    "www.acme.example": "acme.example",
    "https://www.acme.example/": "acme.example",
    "http://eu.acme.example": "eu.acme.example",
    "bücher.example": "xn--bcher-kva.example",
  };
  for (const [cell, domain] of Object.entries(domains)) assert.equal(domainOfCell(cell), domain);
  const none = [
    "",
    "   ",
    "=HYPERLINK(acme.example)",
    "+acme.example",
    "-acme.example",
    "@acme.example",
    " =1+1",
    "jane@acme.example",
    "mailto:jane@acme.example",
    "https://acme.example/about",
    "acme.example/about",
    "acme.example//",
    "acme.example?ref=1",
    "acme.example#top",
    "acme.example:8080",
    "https://user:secret@acme.example",
    "acme.example\nother.example",
    "acme%2eexample",
    "acme .example",
    "ftp://acme.example",
    "acme",
    "localhost",
    "192.168.0.1",
    "linkedin.com",
    "www.linkedin.com/company/acme",
    "uk.linkedin.com",
  ];
  for (const cell of none) assert.equal(domainOfCell(cell), null, JSON.stringify(cell));
});

test("the reader answers each domain's first row by record number, the header's being 1, and the rows without one; `domain` in any case beside other columns; a blank row is no row", async () => {
  const text =
    "﻿Name,DOMAIN\r\nAcme,acme.example\r\n\r\nBeta,=1+1\r\nAcme again,https://www.acme.example/\r\n,\r\nGamma,gamma.example\r\n";
  assert.deepEqual(await fileOf(text), {
    domains: [
      { row: 2, domain: "acme.example" },
      { row: 6, domain: "gamma.example" },
    ],
    rejected: [
      { row: 3, code: "domain_invalid" },
      { row: 4, code: "duplicate" },
    ],
  });
});

test("the leads of the persons at a listed domain or a subdomain become suppressed, never_contact_company, by the uploader; a lookalike domain's do not", async () => {
  const atDomain = await leadAt("ines-listed", "listed-leads.example");
  const atSubdomain = await leadAt("ines-listed-eu", "eu.listed-leads.example");
  const lookalike = await leadAt("ines-lookalike", "notlisted-leads.example");
  await importing(csv("listed-leads.example"));
  const lead = (personId: string) => app().lead.findFirstOrThrow({ where: { personId } });
  for (const personId of [atDomain, atSubdomain]) {
    const { outreachStatus, outreachReason } = await lead(personId);
    assert.deepEqual([outreachStatus, outreachReason], ["suppressed", "never_contact_company"]);
    const change = await app().leadStatusChange.findFirstOrThrow({ where: { personId } });
    assert.deepEqual([change.actorType, change.actorId], ["user", USER]);
  }
  assert.equal((await lead(lookalike)).outreachStatus, "pending_review");
});

test("the import's queries grow with its chunks, not its rows: per chunk, one INSERT of the list's domains, one INSERT … ON CONFLICT of the entries and one read of the companies, then the persons and their leads only where a company matched", async () => {
  const rows = 2 * IMPORT_CHUNK + IMPORT_CHUNK / 2;
  const domain = (index: number) => `chunked-${index}.example`;
  const personId = await leadAt("ines-chunked", domain(IMPORT_CHUNK + 1));
  const reads: string[] = [];
  const counting = asRole("app").$extends({
    query: {
      async $allOperations({ model, operation, args, query }) {
        reads.push(model === undefined ? operation : `${model}.${operation}`);
        return query(args);
      },
    },
  }) as unknown as PrismaClient;
  const cells = Array.from({ length: rows }, (_, index) => domain(index));
  const answer = await importing(csv(...cells), "customer", counting);
  assert.equal(answer.added, rows);
  const chunk = [
    "ExclusionListDomain.createMany",
    "SuppressionEntry.createManyAndReturn",
    "$queryRaw",
  ];
  const write = reads.slice(reads.indexOf("ExclusionList.create") + 1);
  const starts = write.flatMap((read, at) => (read === chunk[0] ? [at] : []));
  assert.equal(starts.length, 3, "three chunks, three statements");
  const [first, second, third] = starts.map((start, at) => write.slice(start, starts[at + 1]));
  assert.deepEqual(first, chunk);
  // The second chunk holds the one company: its persons, their leads, then the lead's move.
  assert.deepEqual(second?.slice(0, 5), [...chunk, "Person.findMany", "Lead.findMany"]);
  assert.deepEqual(third, [...chunk, "ExclusionList.update", "OutboxEntry.create"]);
  const lead = await app().lead.findFirstOrThrow({ where: { personId } });
  assert.equal(lead.outreachStatus, "suppressed");
});

test("a removal ends the list and its active entries, keeps the rows, and leaves an entry removed by hand as it was; the page shows it removed; a second removal, or another workspace's, is exclusion_list_not_found", async () => {
  const { list } = await importing(csv("removed-one.example", "removed-two.example"));
  const entries = await app().suppressionEntry.findMany({
    where: { workspaceId: WORKSPACE, exclusionListId: list.id },
    orderBy: { domain: "asc" },
  });
  const [one, two] = entries;
  assert.ok(one && two);
  await run(() => removeSuppression(two.id, { removedBy: "usr_by_hand" }));
  const handRemoved = await app().suppressionEntry.findUniqueOrThrow({ where: { id: two.id } });
  await run(() => removeExclusionList(list.id, { removedBy: "usr_remover" }));
  const stored = await app().exclusionList.findUniqueOrThrow({ where: { id: list.id } });
  assert.equal(stored.removedBy, "usr_remover");
  assert.ok(stored.removedAt instanceof Date);
  const after = await app().suppressionEntry.findMany({
    where: { workspaceId: WORKSPACE, exclusionListId: list.id },
    orderBy: { domain: "asc" },
  });
  assert.deepEqual(
    after.map(({ id, removedAt, removedBy }) => ({ id, removedAt, removedBy })),
    [
      { id: one.id, removedAt: stored.removedAt, removedBy: "usr_remover" },
      { id: two.id, removedAt: handRemoved.removedAt, removedBy: "usr_by_hand" },
    ],
  );
  const { lists } = await run(() => listExclusionLists({ limit: 100 }));
  const listed = lists.find(({ id }) => id === list.id);
  assert.deepEqual([listed?.removedAt, listed?.removedBy], [stored.removedAt, "usr_remover"]);
  assert.ok(lists.every((row, index) => index === 0 || (lists[index - 1]?.id ?? "") > row.id));
  const removing = () => removeExclusionList(list.id, { removedBy: "usr_remover" });
  const notFound = { code: "exclusion_list_not_found" };
  await assert.rejects(run(removing), notFound);
  const other = { workspaceId: "wsp_contacts_exclusions_other", principal };
  await assert.rejects(withTenant(other, removing, { client: asRole("app") }), notFound);
  // Its domains are free again: a new list adds them anew.
  const again = await importing(csv("removed-one.example"));
  assert.equal(again.added, 1);
});

/** The hashes of the domains a list names, sorted. */
const named = async (listId: string) =>
  (await app().exclusionListDomain.findMany({ where: { exclusionListId: listId } }))
    .map(({ hash }) => hash)
    .sort();
const hashesOf = (...domains: readonly string[]) =>
  domains.map((domain) => domainTarget(domain).hash).sort();

test("an import records every domain its list names by the entries' hash: those it added and its duplicates, held by another list's active entry or twice in the file, once each", async () => {
  const first = await importing(csv("named-one.example", "named-two.example"));
  const second = await importing(
    csv("named-two.example", "named-three.example", "named-three.example"),
    "competitor",
  );
  assert.deepEqual([second.added, second.duplicates], [1, 2]);
  assert.deepEqual(await named(first.list.id), hashesOf("named-one.example", "named-two.example"));
  assert.deepEqual(
    await named(second.list.id),
    hashesOf("named-two.example", "named-three.example"),
  );
  const entry = await app().suppressionEntry.findFirstOrThrow({
    where: { workspaceId: WORKSPACE, domain: "named-two.example" },
  });
  assert.equal(entry.hash, domainTarget("named-two.example").hash, "the entries' hash");
  // A file of duplicates only names its domains too.
  const third = await importing(csv("named-one.example"));
  assert.deepEqual([third.added, await named(third.list.id)], [0, hashesOf("named-one.example")]);
});

test("the migration contacts_exclusion_list_domains fills the lists imported before it: each csv entry's hash with its list, one removed by hand included; a duplicate such a list never stored stays unnamed; run again, it writes nothing", async () => {
  const migrations = new URL("../../../packages/db/prisma/migrations/", import.meta.url);
  const folder = readdirSync(migrations).find((name) =>
    name.endsWith("_contacts_exclusion_list_domains"),
  );
  assert.ok(folder, "the migration's folder");
  const sql = readFileSync(new URL(`${folder}/migration.sql`, migrations), "utf8");
  const fill = sql.slice(sql.indexOf('INSERT INTO "exclusion_list_domains"'));
  const first = await importing(csv("older-one.example", "older-two.example"));
  const later = await importing(csv("older-two.example", "older-three.example"));
  const one = await app().suppressionEntry.findFirstOrThrow({
    where: { workspaceId: WORKSPACE, domain: "older-one.example" },
  });
  await run(() => removeSuppression(one.id, { removedBy: "usr_by_hand" }));
  // As an import before the fix left them: no domain recorded.
  const owner = asRole("owner");
  await owner.exclusionListDomain.deleteMany({ where: { workspaceId: WORKSPACE } });

  assert.equal(await owner.$executeRawUnsafe(fill), 3);
  assert.deepEqual(await named(first.list.id), hashesOf("older-one.example", "older-two.example"));
  assert.deepEqual(await named(later.list.id), hashesOf("older-three.example"));
  assert.equal(await owner.$executeRawUnsafe(fill), 0);
});

test("an import and a removal of one workspace serialize: a removal that meets an import not yet committed waits for the workspace's lock, then finds the domain the import named as a duplicate and moves its entry under the new list", async () => {
  const domain = "racing.example";
  const first = await importing(csv(domain));
  const file = await fileOf(csv(domain, "racing-other.example"));
  const input = {
    name: "competitors.csv",
    relationship: "competitor",
    createdBy: USER,
    file,
  } as const;
  let imported = (): void => undefined;
  let release = (): void => undefined;
  const written = new Promise<void>((resolve) => {
    imported = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const second = run(async () => {
    const answer = await importExclusionList(input);
    imported();
    await held;
    return answer;
  });
  await written;
  let removed = false;
  const removal = run(() => removeExclusionList(first.list.id, { removedBy: USER })).finally(() => {
    removed = true;
  });
  // Until the removal waits for the lock, or has ended without it, which the end state then shows.
  const key = `contacts.exclusions:${WORKSPACE}`;
  const waiting = async () => {
    const [row] = await asRole("owner").$queryRaw<{ waiting: number }[]>`
      SELECT count(*)::int AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND NOT granted
        AND ((classid::bigint << 32) | objid::bigint) = hashtextextended(${key}, 0)`;
    return (row?.waiting ?? 0) > 0;
  };
  for (let tries = 0; !removed && !(await waiting()); tries++) {
    assert.ok(tries < 500, "the removal neither waits nor ends");
    await delay(10);
  }
  release();
  const { list } = await second;
  await removal;
  const active = await app().suppressionEntry.findMany({
    where: { workspaceId: WORKSPACE, domain, removedAt: null },
  });
  assert.deepEqual(
    active.map(({ exclusionListId, relationship }) => [exclusionListId, relationship]),
    [[list.id, "competitor"]],
  );
});

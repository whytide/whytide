// The Companies found list, Not a fit and the CSV in the domain (gamma-wr-110; README.md "Web research"), on
// this file's schema: the list opens on `fit` and `unsure`, newest judged first, in pages by a cursor,
// the `not_fit` filter shows the others and the source's and the agent's filters each narrow it; a row
// carries its reasons (line, quote, page, date read), the page that led to it, its source type and how to
// reach it; Not a fit moves a company to `not_fit` as the member's with who and when, the first mark stays,
// the source's creator and a holder of signals.manage may mark it and no other member (nothing written),
// a company whose source is gone only the latter; after the source is deleted a company stays on the list
// and in the CSV under the source's label; the CSV is the view, with a byte-order mark, one writer's
// neutralized cells (`=`, `+`, `-`, `@`), the company's own address and phones, and every page of a long
// list; workspace B reads none of workspace A's companies. Two made-up businesses in two countries.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { createPlaybook } from "@whytide/playbooks/testing";
import { FOUND_CSV_PAGE } from "../domain/research/constants.ts";
import { foundCompaniesCsv } from "../domain/research/found-csv.ts";
import { listFoundCompanies, markNotFit } from "../domain/research/found-list.ts";
import { createFoundCompany, createSignalSource, useSignalsClient } from "../testing/index.ts";

withTestDb();
const client = asRole("app");
useSignalsClient(client);
const service = servicePrincipal("signals_test");
const asHuman = (workspaceId: string, userId: string, role: "Owner" | "Admin" | "Member") => ({
  workspaceId,
  principal: {
    ...{ userId, actorType: "human" as const, authMethod: "session" as const },
    ...{ membershipId: `mem_${userId}`, role, scopes: [], workspaceId },
  },
});
const inRun = <T>(
  workspaceId: string,
  fn: () => Promise<T>,
  who = { workspaceId, principal: service },
) => withTenant(who, fn, { client });
const refusal = (error: unknown) => (isAppError(error) ? error.code : error);
const fieldsOf = (error: unknown) => (isAppError(error) ? error.details : error);
const DAY = 86_400_000;
const at = (days: number) => new Date(Date.UTC(2026, 10, 1) + days * DAY);
const reason = (over: object = {}) => ({
  ...{ kind: "focus", answer: "shown", line: "Sells cold rooms to restaurants." },
  ...{ quote: "vende câmaras frigoríficas", url: "https://aurora-frio.example/", readAt: at(0) },
  ...over,
});

/** A workspace with two research sources of two creators and their companies, judged on known days. */
async function world(tag: string) {
  const workspaceId = `wsp_found_${tag}`;
  const config = { focus: "cold rooms for restaurants", languages: ["pt"] };
  const made = (label: string, createdBy: string) =>
    createSignalSource({
      workspaceId,
      label,
      kind: "web_research",
      config,
      createdBy,
      senderAccountId: null,
    });
  const brazil = await made("Cold rooms Brazil", "usr_ana");
  const germany = await made("Roasters Germany", "usr_ben");
  const company = (sourceId: string, domain: string, over: object = {}) =>
    createFoundCompany({ workspaceId, sourceId, domain, ...over });
  const aurora = await company(brazil.id, "aurora-frio.example", {
    ...{
      name: "Aurora Frio Ltda",
      verdict: "fit",
      judgedAt: at(3),
      sourceLabel: "Cold rooms Brazil",
    },
    ...{ reasons: [reason()], country: "BR", town: "São Paulo", state: "SP" },
    ...{ placeId: "fair_exhibitors", pageUrl: "https://fair.example/list" },
    ...{ email: "contato@aurora-frio.example", phones: ["+55 11 4002 8922"] },
    postalAddress: "Rua das Flores 120, 01310-100 São Paulo",
  });
  const brandt = await company(germany.id, "brandt-roesterei.example", {
    ...{ name: "Rösterei Brandt", verdict: "unsure", judgedAt: at(2), country: "DE" },
    ...{ sourceLabel: "Roasters Germany" },
  });
  const klein = await company(germany.id, "klein-werk.example", {
    ...{ name: "Klein Werk", verdict: "not_fit", judgedAt: at(1), sourceLabel: "Roasters Germany" },
  });
  const lumiere = await company(brazil.id, "lumiere-froid.example", {
    ...{
      name: "Lumière Froid SARL",
      verdict: "fit",
      judgedAt: at(1),
      sourceLabel: "Cold rooms Brazil",
    },
  });
  return { workspaceId, brazil, germany, aurora, brandt, klein, lumiere };
}
const ids = (rows: readonly { id: string }[]) => rows.map(({ id }) => id);

test("the list opens on fit and unsure, newest judged first; the not_fit filter shows the others; each row says where it came from and how to reach it", async () => {
  const w = await world("list");
  const page = await inRun(w.workspaceId, () => listFoundCompanies({}));
  assert.deepEqual(ids(page.companies), [w.aurora.id, w.brandt.id, w.lumiere.id]);
  assert.equal(page.nextCursor, null);
  const [first] = page.companies;
  assert.deepEqual(
    {
      ...{ name: first?.name, website: first?.website, verdict: first?.verdict },
      ...{ town: first?.town, state: first?.state, country: first?.country },
      ...{ sourceLabel: first?.sourceLabel, sourceId: first?.sourceId },
      ...{ pageUrl: first?.pageUrl, placeId: first?.placeId, email: first?.email },
      ...{ phones: first?.phones, postal: first?.postalAddress, byMember: first?.markedByMember },
    },
    {
      ...{ name: "Aurora Frio Ltda", website: "https://aurora-frio.example/", verdict: "fit" },
      ...{ town: "São Paulo", state: "SP", country: "BR" },
      ...{ sourceLabel: "Cold rooms Brazil", sourceId: w.brazil.id },
      ...{ pageUrl: "https://fair.example/list", placeId: "fair_exhibitors" },
      ...{ email: "contato@aurora-frio.example", phones: ["+55 11 4002 8922"] },
      ...{ postal: "Rua das Flores 120, 01310-100 São Paulo", byMember: false },
    },
  );
  assert.deepEqual(
    first?.reasons.map(({ kind, answer, line, quote, url }) => [kind, answer, line, quote, url]),
    [
      [
        ...["focus", "shown", "Sells cold rooms to restaurants.", "vende câmaras frigoríficas"],
        "https://aurora-frio.example/",
      ],
    ],
  );
  const others = await inRun(w.workspaceId, () => listFoundCompanies({ verdict: "not_fit" }));
  assert.deepEqual(ids(others.companies), [w.klein.id]);
  const fit = await inRun(w.workspaceId, () => listFoundCompanies({ verdict: "fit" }));
  assert.deepEqual(ids(fit.companies), [w.aurora.id, w.lumiere.id]);
});

test("the source's filter and the agent's each narrow the list, and both together; an agent with no sources, or another workspace's source, answers none", async () => {
  const w = await world("filters");
  const playbookId = await createPlaybook({
    ...{ workspaceId: w.workspaceId, icpId: "icp_none", ownerUserId: "usr_ana" },
    sourceIds: [w.germany.id],
  });
  const empty = await createPlaybook({
    ...{ workspaceId: w.workspaceId, icpId: "icp_second", ownerUserId: "usr_ana", name: "Empty" },
  });
  const list = (filter: object) => inRun(w.workspaceId, () => listFoundCompanies(filter));
  assert.deepEqual(ids((await list({ sourceId: w.brazil.id })).companies), [
    w.aurora.id,
    w.lumiere.id,
  ]);
  assert.deepEqual(ids((await list({ playbookId })).companies), [w.brandt.id]);
  assert.deepEqual(ids((await list({ playbookId, verdict: "not_fit" })).companies), [w.klein.id]);
  assert.deepEqual((await list({ playbookId, sourceId: w.brazil.id })).companies, []);
  assert.deepEqual((await list({ playbookId: empty })).companies, []);
  assert.deepEqual((await list({ sourceId: "src_unknown" })).companies, []);
});

test("the list is in pages by a cursor: no company twice or lost, ties in judgment time ordered by id, a bad cursor refused naming the field", async () => {
  const workspaceId = "wsp_found_pages";
  const source = await createSignalSource({
    workspaceId,
    label: "Pages",
    kind: "web_research",
    senderAccountId: null,
  });
  const made = [];
  for (let n = 0; n < 7; n += 1) {
    // Pairs share a judgment time.
    const judgedAt = at(Math.floor(n / 2));
    made.push(
      await createFoundCompany({
        workspaceId,
        sourceId: source.id,
        domain: `co-${n}.example`,
        judgedAt,
      }),
    );
  }
  const seen: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await inRun(workspaceId, () => listFoundCompanies({}, { limit: 3, cursor }));
    seen.push(...ids(page.companies));
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor !== undefined);
  assert.equal(pages, 3);
  const rows = await client.signalFoundCompany.findMany({ where: { workspaceId } });
  const newest = rows.sort(
    (a, b) => b.judgedAt.getTime() - a.judgedAt.getTime() || b.id.localeCompare(a.id),
  );
  assert.deepEqual(seen, ids(newest));
  assert.equal(new Set(seen).size, made.length);
  const bad = inRun(workspaceId, () => listFoundCompanies({}, { cursor: "not-a-cursor" }));
  assert.equal(await bad.catch(refusal), "signal_config_invalid");
  assert.deepEqual(await bad.catch(fieldsOf), { fields: ["cursor"] });
});

test("Not a fit moves a company to not_fit as the member's, with who and when; a second mark changes nothing; the list and the not_fit filter follow", async () => {
  const w = await world("mark");
  const ana = asHuman(w.workspaceId, "usr_ana", "Member");
  const marked = await inRun(w.workspaceId, () => markNotFit(w.aurora.id, at(10)), ana);
  assert.deepEqual(
    [marked.verdict, marked.markedByMember, marked.markedBy, marked.markedAt?.toISOString()],
    ["not_fit", true, "usr_ana", at(10).toISOString()],
  );
  const row = await client.signalFoundCompany.findUniqueOrThrow({ where: { id: w.aurora.id } });
  assert.deepEqual(
    [row.verdict, row.memberMark, row.memberMarkedBy],
    ["not_fit", "not_fit", "usr_ana"],
  );
  // An Owner marks it again: the first mark's who and when stay.
  const again = await inRun(
    w.workspaceId,
    () => markNotFit(w.aurora.id, at(11)),
    asHuman(w.workspaceId, "usr_owner", "Owner"),
  );
  assert.deepEqual(
    [again.markedBy, again.markedAt?.toISOString()],
    ["usr_ana", at(10).toISOString()],
  );
  const open = await inRun(w.workspaceId, () => listFoundCompanies({}));
  assert.deepEqual(ids(open.companies), [w.brandt.id, w.lumiere.id]);
  const notFit = await inRun(w.workspaceId, () => listFoundCompanies({ verdict: "not_fit" }));
  assert.deepEqual(ids(notFit.companies), [w.aurora.id, w.klein.id]);
  // A company the run judged not_fit becomes the member's too, its verdict unchanged.
  const own = await inRun(
    w.workspaceId,
    () => markNotFit(w.klein.id, at(12)),
    asHuman(w.workspaceId, "usr_ben", "Member"),
  );
  assert.deepEqual([own.verdict, own.markedByMember, own.markedBy], ["not_fit", true, "usr_ben"]);
});

test("a member who may not write the source is refused before anything is written; a holder of signals.manage may mark any; a company whose source is gone is marked by signals.manage alone", async () => {
  const w = await world("rights");
  const other = asHuman(w.workspaceId, "usr_ben", "Member");
  const denied = inRun(w.workspaceId, () => markNotFit(w.aurora.id), other);
  assert.equal(await denied.catch(refusal), "forbidden");
  const untouched = await client.signalFoundCompany.findUniqueOrThrow({
    where: { id: w.aurora.id },
  });
  assert.deepEqual(
    [untouched.verdict, untouched.memberMark, untouched.memberMarkedBy],
    ["fit", null, null],
  );
  const admin = await inRun(
    w.workspaceId,
    () => markNotFit(w.aurora.id),
    asHuman(w.workspaceId, "usr_admin", "Admin"),
  );
  assert.equal(admin.markedBy, "usr_admin");
  // The source goes: its company stays, and only signals.manage writes it.
  await client.signalSource.delete({ where: { id: w.germany.id } });
  const gone = inRun(
    w.workspaceId,
    () => markNotFit(w.brandt.id),
    asHuman(w.workspaceId, "usr_ben", "Member"),
  );
  assert.equal(await gone.catch(refusal), "forbidden");
  const owner = await inRun(
    w.workspaceId,
    () => markNotFit(w.brandt.id),
    asHuman(w.workspaceId, "usr_owner", "Owner"),
  );
  assert.deepEqual(
    [owner.sourceId, owner.sourceLabel, owner.verdict],
    [null, "Roasters Germany", "not_fit"],
  );
  const missing = inRun(
    w.workspaceId,
    () => markNotFit("fco_unknown"),
    asHuman(w.workspaceId, "usr_owner", "Owner"),
  );
  assert.equal(await missing.catch(refusal), "signal_found_company_not_found");
});

test("after its source is deleted a company stays on the list and in the CSV, under the label it was kept with; a renamed source shows its label now", async () => {
  const w = await world("deleted");
  await client.signalSource.update({
    where: { id: w.brazil.id },
    data: { label: "Cold rooms, renamed" },
  });
  await client.signalSource.delete({ where: { id: w.germany.id } });
  const page = await inRun(w.workspaceId, () => listFoundCompanies({}));
  assert.deepEqual(
    page.companies.map(({ id, sourceId, sourceLabel }) => [id, sourceId, sourceLabel]),
    [
      [w.aurora.id, w.brazil.id, "Cold rooms, renamed"],
      [w.brandt.id, null, "Roasters Germany"],
      [w.lumiere.id, w.brazil.id, "Cold rooms, renamed"],
    ],
  );
  const csv = (await read(foundCompaniesCsv({}, (fn) => inRun(w.workspaceId, fn)))).split("\r\n");
  assert.ok(
    csv.some((line) => line.includes("Rösterei Brandt") && line.includes("Roasters Germany")),
  );
});

async function read(chunks: AsyncIterable<string>): Promise<string> {
  let text = "";
  for await (const chunk of chunks) text += chunk;
  return text;
}

test("the CSV is the list's view with a byte-order mark: the header, then each company by the CSV writer of contacts, a cell that starts with =, +, -, or @ neutralized, the company's own address and phones, every page of a long list", async () => {
  const workspaceId = "wsp_found_csv";
  const source = await createSignalSource({
    workspaceId,
    label: "=Cmd label",
    kind: "web_research",
    senderAccountId: null,
  });
  const named = ["=SUM(A1)", "+48 600 000 000", "-1+1", "@HYPERLINK(1)", 'Plain, "quoted" Ltd'];
  for (const [n, name] of named.entries()) {
    await createFoundCompany({
      ...{
        workspaceId,
        sourceId: source.id,
        domain: `csv-${n}.example`,
        name,
        judgedAt: at(100 - n),
      },
      ...{
        sourceLabel: "x",
        email: "info@csv.example",
        phones: ["+48 22 100 20 30", "(22) 100 20 31"],
      },
      reasons: [
        reason({ line: "=1+1", quote: "q1" }),
        reason({ kind: "must_have", line: "Second", quote: "q2" }),
      ],
    });
  }
  // More than one page of the file, so that each page is read in a run of its own.
  for (let n = 0; n < FOUND_CSV_PAGE; n += 1) {
    await createFoundCompany({
      workspaceId,
      sourceId: source.id,
      domain: `bulk-${n}.example`,
      judgedAt: at(n % 50),
    });
  }
  const text = await read(foundCompaniesCsv({}, (fn) => inRun(workspaceId, fn)));
  assert.ok(
    text.startsWith("﻿company,website,verdict,"),
    "the byte-order mark and the header come first",
  );
  const lines = text.split("\r\n");
  assert.ok(lines[0]?.includes("postal_address"));
  // The five named companies are the newest, in order; each neutralized cell starts with an apostrophe.
  assert.ok(lines[1]?.startsWith("'=SUM(A1),"));
  assert.ok(lines[2]?.startsWith("'+48 600 000 000,"));
  assert.ok(lines[3]?.startsWith("'-1+1,"));
  assert.ok(lines[4]?.startsWith("'@HYPERLINK(1),"));
  assert.ok(lines[5]?.startsWith('"Plain, ""quoted"" Ltd",'));
  assert.ok(lines[1]?.includes("'=Cmd label"), "the source's label is a cell too");
  assert.ok(lines[1]?.includes("info@csv.example"));
  assert.ok(
    lines[1]?.includes("'+48 22 100 20 30; (22) 100 20 31"),
    "a phone list starts with + and is neutralized",
  );
  // 5 named + 100 bulk companies, the header and the final empty split.
  assert.equal(lines.length, 1 + 105 + 1);
  assert.equal(lines.at(-1), "");
  // The CSV of a filtered view holds that view only.
  const none = await read(
    foundCompaniesCsv({ verdict: "not_fit" }, (fn) => inRun(workspaceId, fn)),
  );
  assert.equal(none.split("\r\n").length, 2);
});

test("workspace B reads none of workspace A's found companies, in the list, in Not a fit or in the CSV", async () => {
  const a = await world("tenant_a");
  const b = await world("tenant_b");
  const asB = await inRun(b.workspaceId, () => listFoundCompanies({ verdict: "not_fit" }));
  assert.deepEqual(ids(asB.companies), [b.klein.id]);
  const mine = await inRun(b.workspaceId, () => listFoundCompanies({ sourceId: a.brazil.id }));
  assert.deepEqual(mine.companies, []);
  const denied = inRun(b.workspaceId, () => markNotFit(a.aurora.id));
  assert.equal(await denied.catch(refusal), "signal_found_company_not_found");
  const csv = await read(foundCompaniesCsv({}, (fn) => inRun(b.workspaceId, fn)));
  assert.ok(
    !csv.includes(a.aurora.id) && csv.includes("Aurora Frio Ltda"),
    "B's own Aurora is B's",
  );
  const rowA = await client.signalFoundCompany.findUniqueOrThrow({ where: { id: a.aurora.id } });
  assert.equal(rowA.memberMark, null);
});

test("a row names the leads found there from the research events, the first ones with name and title and the count of all, oldest first; the CSV carries them as names and titles only; an erased person is left out", async () => {
  const workspaceId = "wsp_found_leads";
  const source = await createSignalSource({
    workspaceId,
    label: "Cold rooms",
    kind: "web_research",
    senderAccountId: null,
  });
  const withPeople = await createFoundCompany({
    workspaceId,
    sourceId: source.id,
    domain: "with.example",
  });
  const alone = await createFoundCompany({
    workspaceId,
    sourceId: source.id,
    domain: "alone.example",
  });
  const made: [string, string | null, string | null, string | null][] = [
    ["per_found_a", "Ana", "Reis", "Head of Sales"],
    ["per_found_b", "Bo", null, null],
    ["per_found_c", null, null, "=Buyer"],
    ["per_found_gone", "Gone", "Person", "Owner"],
  ];
  for (const [n, [id, firstName, lastName, title]] of made.entries()) {
    await client.person.create({
      data: {
        ...{ id, workspaceId, firstName, lastName, title, fieldProvenance: {} },
        linkedinUrl: `https://www.linkedin.com/in/found-lead-${n}`,
      },
    });
    await client.signalEvent.create({
      data: {
        ...{ id: `sev_found_lead_${n}`, workspaceId, personId: id, sourceId: source.id },
        ...{ kind: "web_research", dedupeKey: `found-lead-${n}`, foundCompanyId: withPeople.id },
        occurredAt: new Date(at(10 - n)),
      },
    });
  }
  await client.person.delete({ where: { id: "per_found_gone" } });
  const page = await inRun(workspaceId, () => listFoundCompanies({}));
  const row = page.companies.find(({ id }) => id === withPeople.id);
  assert.deepEqual(row?.leads, [
    { personId: "per_found_c", name: null, title: "=Buyer" },
    { personId: "per_found_b", name: "Bo", title: null },
    { personId: "per_found_a", name: "Ana Reis", title: "Head of Sales" },
  ]);
  assert.equal(row?.leadCount, 4);
  const none = page.companies.find(({ id }) => id === alone.id);
  assert.deepEqual([none?.leads, none?.leadCount], [[], 0]);
  const lines: string[] = [];
  for await (const chunk of foundCompaniesCsv({}, (fn) => inRun(workspaceId, fn)))
    lines.push(chunk);
  const csv = lines.join("");
  assert.ok(csv.includes("leads_found,leads"));
  assert.ok(csv.includes("'=Buyer"), "a title is a cell like any other, neutralized");
  assert.ok(csv.includes("Ana Reis, Head of Sales"));
});

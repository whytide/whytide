// qualification's golden set end to end (alpha-p9-050; core/modules/qualification/README.md "The
// golden set"): the host started with identity, contacts and qualification, on the fake
// authentication adapter, in a schema of the worktree's database, the files port on the slice's own
// storage (.env.local), answering real HTTP. The leads are written by contacts' commands, their
// snapshots and decision records as the assessment leaves them, no model called; the reviews go
// through contacts' route. Then `pnpm export:golden`'s command. It lives here: a module never imports
// a host. Made-up names and profile URLs only.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { text } from "node:stream/consumers";
import { after, before, test } from "node:test";
import {
  applyQualification,
  createLeadForPerson,
  linkPersonToCompany,
  upsertCompany,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId, servicePrincipal } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
// The host reads it as its config loads: set before anything of the host is imported.
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

// qualification by its build's path, as src/modules.generated.ts loads it: the api lists it nowhere.
const build = new URL("../../../../modules/qualification/dist/", import.meta.url);
type Testing = typeof import("../../../modules/qualification/dist/testing/index.js");
type Cli = typeof import("../../../modules/qualification/dist/cli/export-golden.js");
const { useQualificationClient }: Testing = await import(new URL("testing/index.js", build).href);
const { runExportGolden }: Cli = await import(new URL("cli/export-golden.js", build).href);

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
useQualificationClient(asRole("app"));
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
      { name: "qualification", load: () => import(new URL("index.js", build).href) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
  });
});
after(() => api?.close());

/** The blocks the model saw, as a decision record keeps them: anonymized, with a `<`. */
const SEEN = {
  profile: {
    headline: "[name] [name] | Head of Data | [link]",
    title: "Head of Data",
    country: null,
  },
  company: { name: "Blue Harbor Labs", industry: "Software", size: "51-200" },
  evidence: ["Hiring a data team <2026>"],
  icp: {
    titles: ["Head of Data"],
    seniorities: [],
    industries: [],
    company_sizes: [],
    countries: [],
  },
  must_haves: "Runs a data team",
  disqualifiers: "Agencies",
};
/** The user message as the ai package writes it (core/packages/ai run/run-agent.ts). */
const promptOf = (input: Record<string, unknown>) =>
  Object.entries(input)
    .map(([name, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return `<${name}>\n${text.replaceAll("<", "&lt;")}\n</${name}>`;
    })
    .join("\n\n");
const VERDICTS = [
  { criterion: "title_function", verdict: "met", evidence: "Head of Data" },
  { criterion: "seniority", verdict: "met", evidence: "Head of Data" },
  { criterion: "company_size", verdict: "met", evidence: "51-200" },
  { criterion: "industry", verdict: "met", evidence: "Software" },
  { criterion: "location", verdict: "unknown", evidence: "" },
  { criterion: "must_haves", verdict: "unknown", evidence: "" },
] as const;

/**
 * A person: the decision record keeps the prompt, keeps it past its raw_purge_after (no purge ran),
 * the raw purge emptied it, or no assessment.
 */
type Kind = "kept" | "expired" | "purged" | "none";
type Person = { first: string; last: string; kind: Kind };
const urlOf = ({ first, last }: Person) => `https://linkedin.com/in/${first}-${last}`.toLowerCase();

/** The persons with their company and leads; each assessed one with its snapshot and record. */
const seed = ({ workspace }: TestTenant, people: readonly Person[]) =>
  withTenant(
    { workspaceId: workspace.id, principal: servicePrincipal("qualification_test") },
    async (tx) => {
      const company = {
        name: "Blue Harbor Labs",
        domain: "blueharbor.example",
        industry: "Software",
        sizeRange: "51-200",
      };
      const source = { source: "import", provider: "csv" } as const;
      const { company: stored } = await upsertCompany({ ...source, company });
      const ids: string[] = [];
      for (const person of people) {
        const { first, last, kind } = person;
        const headline = `${first} ${last} | Head of Data | https://${first}.example.com`;
        const profile = { linkedinUrl: urlOf(person), firstName: first, lastName: last, headline };
        const { person: row } = await upsertPersonFromSource({ ...source, profile });
        const personId = row.id;
        ids.push(personId);
        await linkPersonToCompany({ personId, companyId: stored.id });
        await createLeadForPerson({ personId, source: { kind: "imported", ref: "imp_1" } });
        if (kind === "none") continue;
        const decisionRecordId = newId("dec");
        await tx.decisionRecord.create({
          data: {
            id: decisionRecordId,
            workspaceId: workspace.id,
            task: "qualification.assess-fit",
            subjectRef: personId,
            modelId: "fake-model",
            promptVersion: 1,
            inputHash: decisionRecordId,
            status: "ok",
            gates: [],
            latencyMs: 1,
            inputTokens: 1,
            outputTokens: 1,
            costCredits: 0,
            attempts: 1,
            rawPrompt: kind === "purged" ? null : promptOf(SEEN),
            rawPurgeAfter: new Date(Date.now() + (kind === "expired" ? -1 : 30) * 86_400_000),
          },
        });
        const snapshotId = newId("ssn");
        const scores = {
          status: "qualified",
          fitScore: 82,
          confidence: "high",
          tier: "hot",
        } as const;
        await tx.scoreSnapshot.create({
          data: {
            ...scores,
            id: snapshotId,
            workspaceId: workspace.id,
            personId,
            icpVersion: 1,
            modelId: "fake-model",
            promptVersion: 1,
            scorerVersion: "fit-v1",
            disqualifiers: [],
            summary: `${first} leads data at a software company.`,
            decisionRecordId,
          },
        });
        await tx.criterionVerdict.createMany({
          data: VERDICTS.map((verdict) => ({
            ...verdict,
            id: newId("cvd"),
            workspaceId: workspace.id,
            snapshotId,
          })),
        });
        await applyQualification({ personId, ...scores, snapshotId, icpVersion: 1 });
      }
      return ids;
    },
    { client: asRole("app") },
  );

const cookieOf = (tenant: TestTenant) =>
  signInAs(tenant.user.id)
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");
/** The tester's decision through contacts' route. */
async function review(tenant: TestTenant, personId: string, body: Record<string, string>) {
  const path = `/v1/workspaces/${tenant.workspace.id}/contacts/leads/${personId}/review`;
  const res = await fetch(new URL(path, api.url), {
    method: "POST",
    headers: { cookie: cookieOf(tenant), origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 201, await res.text());
}
/** GET …/qualification/exports/golden-set.jsonl of the workspace, as the tenant's user. */
async function goldenSet(tenant: TestTenant, workspaceId = tenant.workspace.id, query = "") {
  const path = `/v1/workspaces/${workspaceId}/qualification/exports/golden-set.jsonl${query}`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookieOf(tenant) } });
  const body = await res.text();
  const lines = res.ok
    ? body
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { res, body, lines: lines as Record<string, unknown>[] };
}
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** The stored file of a whole key. */
async function stored(workspaceId: string, key: string) {
  const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);
  return text((await files.get({ workspaceId, key })).body);
}
/** The ISO week of a day, `2026-W43`, in UTC: its Thursday's year and week. */
function isoWeek(day: Date): string {
  const monday = (day.getUTCDay() + 6) % 7;
  const thursday = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 3 - monday),
  );
  const year = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

const PEOPLE: Person[] = [
  { first: "Ottoline", last: "Vashti", kind: "kept" },
  { first: "Bramwell", last: "Okonkwo", kind: "purged" },
  { first: "Saoirse", last: "Delacroix", kind: "none" },
  { first: "Linnea", last: "Haverkamp", kind: "expired" },
  { first: "Tamsin", last: "Achterberg", kind: "kept" },
];

test("GET …/qualification/exports/golden-set.jsonl: a line per reviewed lead, the input from the decision record until its raw_purge_after, else rebuilt; no name, URL or id; the file under exports/, and pnpm export:golden writes the same", async () => {
  const [a] = await createTwoWorkspaces();
  const [kept = "", purged = "", none = "", expired = ""] = await seed(a, PEOPLE);
  await review(a, kept, { decision: "good_lead", goodReasonText: "Runs the data team we sell to" });
  const tooSmall = { reasonCode: "company_wrong_size", reasonText: "Ten people at most" };
  await review(a, purged, { decision: "not_a_fit", ...tooSmall });
  await review(a, none, { decision: "not_a_fit", reasonCode: "other", reasonText: "Retired" });
  await review(a, expired, { decision: "good_lead", goodReasonText: "Leads the data team" });

  const { res, body, lines } = await goldenSet(a);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/jsonl; charset=utf-8");
  const file = /^attachment; filename="(golden-set-\d{4}-\d{2}-\d{2}\.jsonl)"$/;
  const name = file.exec(res.headers.get("content-disposition") ?? "")?.[1];
  assert.ok(name);
  assert.equal(lines.length, 4);
  assert.ok(body.endsWith("\n"));
  const byPerson = new Map(lines.map((line) => [line.person_sha256, line]));
  const keptLine = byPerson.get(sha256(kept));
  assert.deepEqual(keptLine, {
    person_sha256: sha256(kept),
    input_from: "decision_record",
    input: SEEN,
    model_id: "fake-model",
    prompt_version: 1,
    verdicts: VERDICTS,
    disqualifiers: [],
    status: "qualified",
    fit: 82,
    tier: "hot",
    decision: "good_lead",
    reason_code: null,
    reason_text: null,
    good_reason_text: "Runs the data team we sell to",
  });
  const rebuilt = {
    profile: { headline: "[name] [name] | Head of Data | [link]", title: null, country: null },
    company: { name: "Blue Harbor Labs", industry: "Software", size: "51-200" },
    evidence: [],
    icp: { titles: [], seniorities: [], industries: [], company_sizes: [], countries: [] },
    must_haves: "",
    disqualifiers: "",
  };
  const purgedLine = byPerson.get(sha256(purged)) ?? {};
  assert.deepEqual(
    [purgedLine.input_from, purgedLine.input, purgedLine.verdicts, purgedLine.fit],
    ["rebuilt", rebuilt, VERDICTS, 82],
  );
  assert.deepEqual(
    [purgedLine.decision, purgedLine.reason_code, purgedLine.reason_text],
    ["not_a_fit", "company_wrong_size", "Ten people at most"],
  );
  const noneLine = byPerson.get(sha256(none)) ?? {};
  assert.deepEqual(
    [noneLine.input_from, noneLine.input, noneLine.verdicts, noneLine.fit, noneLine.reason_code],
    ["rebuilt", rebuilt, [], null, "other"],
  );
  // A prompt past its raw_purge_after counts as purged, though no purge ran.
  const expiredLine = byPerson.get(sha256(expired)) ?? {};
  assert.deepEqual([expiredLine.input_from, expiredLine.input], ["rebuilt", rebuilt]);
  for (const person of PEOPLE) {
    for (const value of [person.first, person.last, urlOf(person), "linkedin"]) {
      assert.doesNotMatch(body, new RegExp(value, "i"), value);
    }
  }
  assert.doesNotMatch(body, /\b(?:per|ssn|cvd|dec|rvd|wsp|usr)_[0-9A-Za-z]/);

  const key = `w/${a.workspace.id}/exports/${name}`;
  assert.equal(await stored(a.workspace.id, key), body);
  const printed: string[] = [];
  assert.equal(
    await runExportGolden(["--workspace", a.workspace.slug], (line) => printed.push(line)),
    0,
  );
  assert.deepEqual(printed, [`golden_set_written: ${key}, 4 lines`]);
  assert.equal(await stored(a.workspace.id, key), body);

  const week = await goldenSet(a, a.workspace.id, `?week=${isoWeek(new Date())}`);
  assert.equal(week.body, body);
  const older = await goldenSet(a, a.workspace.id, "?week=2020-W01");
  assert.deepEqual([older.res.status, older.body], [200, ""]);
  const missing = await goldenSet(a, a.workspace.id, "?week=2026-W60");
  assert.deepEqual(
    [missing.res.status, JSON.parse(missing.body)],
    [400, { code: "contacts_input_invalid", details: { fields: ["week"] } }],
  );
  const malformed = await goldenSet(a, a.workspace.id, "?week=soon");
  assert.deepEqual(
    [malformed.res.status, JSON.parse(malformed.body)],
    [400, { code: "validation_failed", details: { fields: ["week"] } }],
  );
  printed.length = 0;
  const args = ["--workspace", a.workspace.id, "--week", "2026-W60"];
  assert.equal(await runExportGolden(args, (line) => printed.push(line)), 1);
  assert.equal(await runExportGolden([], (line) => printed.push(line)), 2);
  assert.deepEqual(printed, [
    `contacts_input_invalid: ${a.workspace.id} 2026-W60`,
    "usage: pnpm export:golden --workspace <id or slug> [--week <ISO week>]",
  ]);
});

test("two workspaces: each one's golden set holds its own reviewed leads only, and a member of one cannot export the other's", async () => {
  const [a, b] = await createTwoWorkspaces();
  const person: Person = { first: "Ottoline", last: "Vashti", kind: "kept" };
  const [ours = ""] = await seed(a, [person]);
  const [theirs = ""] = await seed(b, [person, { ...person, last: "Quist" }]);
  await review(a, ours, { decision: "good_lead", goodReasonText: "Fits" });
  await review(b, theirs, { decision: "not_a_fit", reasonCode: "contact_wrong_seniority" });

  const mine = await goldenSet(a);
  assert.deepEqual(
    mine.lines.map((line) => [line.person_sha256, line.decision]),
    [[sha256(ours), "good_lead"]],
  );
  const other = await goldenSet(b);
  assert.deepEqual(
    other.lines.map((line) => [line.person_sha256, line.decision]),
    [[sha256(theirs), "not_a_fit"]],
  );
  const refused = await goldenSet(a, b.workspace.id);
  assert.deepEqual([refused.res.status, JSON.parse(refused.body)], [403, { code: "forbidden" }]);
});

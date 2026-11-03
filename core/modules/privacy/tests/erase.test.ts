// The deletion script end to end on the worktree's database (README.md "The deletion script"). The
// fixture person has a lead with a review decision, a snapshot with its verdicts and attempt, two
// events with their evidence, two drafts, three decision records, four outbox events, an endpoint's
// stored answer, a cost event and a credit reservation. `pnpm erase` by URL deletes every row that
// names the person: a scan of every table finds the id in cost_events and credit_usage only, which
// keep it (docs/security.md), and the name and the URL nowhere; it writes the erased hashes and the
// log row with the counts by module, and prints the counts. A later import or signal run meets the
// erased hash. The dry run prints the same counts and changes nothing; a failing eraser rolls every
// row back; another person, and the same person in another workspace, keep their rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createLeadForPerson,
  isHashed,
  upsertPersonFromSource,
  upsertPersonsFromSource,
} from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createSignalEvent } from "@whytide/signals/testing";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { runErase } from "../cli/erase.ts";
import { useClient } from "../domain/client.ts";
import { erase } from "../domain/erase/erase.ts";
import { registeredErasers } from "../domain/erase/registry.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useClient(asRole("app"));
useTenancyClient(asRole("app"));

const principal = servicePrincipal("privacy_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

/** The fixture person, synthetic; the URL as a member would paste it. */
const SLUG = "ysolde-marrowcliffe-7q2";
const MEMBER = "ACoAAYsoldeMarrowcliffe";
const PROFILE = {
  linkedinUrl: `https://www.linkedin.com/in/${SLUG}/`,
  providerId: MEMBER,
  firstName: "Ysolde",
  lastName: "Marrowcliffe",
  headline: "Ysolde Marrowcliffe | Head of Revenue Operations",
  title: "Head of Revenue Operations",
  companyName: "Brackwater Analytics",
  locationText: "Lisbon, Portugal",
};
const OTHER = {
  linkedinUrl: "https://linkedin.com/in/tobiah-vantongeren-k41",
  firstName: "Tobiah",
  lastName: "Vantongeren",
  headline: "VP Sales",
};
/** What a scan of the tables looks for once the person is erased: nothing, but the id where kept. */
const NAMES = ["ysolde", "marrowcliffe", SLUG, MEMBER];
const KEEP_ID = ["cost_events", "credit_usage"];
const OPERATOR = "dpo@example.com";

const COUNTS = [
  "messaging.message_drafts: 2",
  "platform.outbox: 4",
  "platform.idempotency_records: 1",
  "qualification.score_snapshots: 1",
  "qualification.criterion_verdicts: 6",
  "qualification.assessment_attempts: 1",
  "ai.decision_records: 3",
  "signals.signal_events: 2",
  "signals.evidence: 2",
  "contacts.review_decisions: 1",
  "contacts.leads: 1",
  "contacts.persons: 1",
];
const CRITERIA = [
  "title_function",
  "seniority",
  "company_size",
  "industry",
  "location",
  "must_haves",
] as const;

let made = 0;
const idOf = (prefix: string) => `${prefix}_fixture${++made}`;

/** A person with a lead, through contacts' commands; its id. */
async function personWithLead(workspaceId: string, profile: typeof PROFILE | typeof OTHER) {
  return inRun(workspaceId, async () => {
    const provider = "providerId" in profile ? "unipile" : "csv";
    const source = "providerId" in profile ? "linkedin" : "import";
    const { person } = await upsertPersonFromSource({ source, provider, profile });
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sig_1" } });
    return person.id;
  });
}

/** The person's rows in every module that keeps some, written as each module writes them. */
async function rowsOf(
  workspaceId: string,
  organizationId: string,
  personId: string,
  profile: typeof PROFILE | typeof OTHER,
): Promise<void> {
  const name = `${profile.firstName} ${profile.lastName}`;
  await inRun(workspaceId, async (tx) => {
    const records = [
      "qualification.assess-fit",
      "messaging.write-message",
      "messaging.write-message",
    ];
    const recordIds = records.map(() => idOf("dec"));
    await tx.decisionRecord.createMany({
      data: records.map((task, i) => ({
        id: recordIds[i] as string,
        workspaceId,
        task,
        subjectRef: personId,
        modelId: "fake-model",
        promptVersion: 1,
        inputHash: idOf("hash"),
        status: "ok" as const,
        output: { summary: `${name} runs revenue operations` },
        gates: [],
        latencyMs: 1,
        inputTokens: 1,
        outputTokens: 1,
        costCredits: 0,
        attempts: 1,
        rawPrompt: `The profile: ${name}, ${profile.linkedinUrl}`,
        rawOutput: `{"summary": "${name}"}`,
        rawPurgeAfter: new Date(Date.now() + 86_400_000),
      })),
    });
    const [assessed, ...written] = recordIds as [string, string, string];
    const snapshotId = idOf("ssn");
    await tx.scoreSnapshot.create({
      data: {
        ...{ id: snapshotId, workspaceId, personId, icpVersion: 1, modelId: "fake-model" },
        ...{ promptVersion: 1, fitScore: 88, confidence: "high", tier: "hot" },
        summary: `${name} heads revenue operations`,
        decisionRecordId: assessed,
      },
    });
    await tx.criterionVerdict.createMany({
      data: CRITERIA.map((criterion) => ({
        ...{ id: idOf("cvd"), workspaceId, snapshotId, criterion, verdict: "met" as const },
        evidence: `${name}, Head of Revenue Operations`,
      })),
    });
    await tx.assessmentAttempt.create({
      data: { workspaceId, personId, icpVersion: 1, attempt: 2 },
    });
    for (const decisionRecordId of written) {
      await tx.messageDraft.create({
        data: {
          ...{ id: idOf("mdr"), workspaceId, personId, channel: "linkedin_message" },
          ...{
            status: "ready",
            text: `Hi ${name}, a question about your pipeline`,
            decisionRecordId,
          },
          plan: { angle: "pipeline", factIds: [], cta: "call", decisionRecordId },
        },
      });
    }
    await tx.reviewDecision.create({
      data: {
        ...{ id: idOf("rvd"), workspaceId, personId, decision: "good_lead", snapshotId },
        ...{ goodReasonText: `${name} runs the team we sell to`, decidedBy: "usr_fixture" },
      },
    });
    await tx.costEvent.create({
      data: {
        ...{ id: idOf("cst"), workspaceId, feature: "qualification", vendor: "fake" },
        ...{
          units: { input_tokens: 1 },
          unitCost: 0,
          priceListVersion: "test",
          subjectRef: personId,
        },
      },
    });
    await tx.creditUsage.create({
      data: {
        ...{ id: idOf("cus"), organizationId, workspaceId, action: "qualification.assess" },
        ...{ quantity: 1, credits: 1, idempotencyKey: `qual:${personId}:1:fake-model:1` },
        ...{ leaseExpiresAt: new Date(Date.now() + 60_000), subjectRef: personId },
      },
    });
  });
  for (const at of [1, 2]) {
    const commentText = `${name} here: we rebuilt our pipeline (${at})`;
    await createSignalEvent({ workspaceId, personId, commentText, author: name });
  }
}

/** The fixture: the person and another in workspace A, the same person in workspace B. */
async function fixture() {
  const a = await createOrganizationWithWorkspace();
  const b = await createOrganizationWithWorkspace();
  const [A, B] = [a.workspace.id, b.workspace.id];
  const personId = await personWithLead(A, PROFILE);
  const otherId = await personWithLead(A, OTHER);
  const inB = await personWithLead(B, PROFILE);
  await rowsOf(A, a.organization.id, personId, PROFILE);
  await rowsOf(A, a.organization.id, otherId, OTHER);
  await rowsOf(B, b.organization.id, inB, PROFILE);
  const app = asRole("app");
  const event = (eventName: string, payload: Record<string, unknown>) => ({
    ...{ id: idOf("evt"), workspaceId: A, eventName },
    payload: { workspaceId: A, ...payload },
  });
  await app.outboxEntry.createMany({
    data: [
      event("contacts.lead_reviewed", { personId, decision: "good_lead" }),
      event("contacts.lead_reviewed", { personId: otherId, decision: "good_lead" }),
      event("messaging.draft_requested", { draftId: "mdr_1", personId, userId: "usr_1" }),
      event("signals.person_found", { personIds: [personId, otherId] }),
      event("discovery.people_imported", { jobId: "imp_1", personIds: [personId] }),
    ],
  });
  // A draft's POST answered with the draft, kept for its idempotency key.
  const answer = { id: "mdr_1", personId, text: "Hi Ysolde Marrowcliffe" };
  await app.idempotencyRecord.create({
    data: {
      ...{ id: idOf("idm"), workspaceId: A, key: "key_1", requestHash: "hash" },
      ...{
        responseStatus: 201,
        responseBody: answer,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    },
  });
  return { A, B, slug: a.workspace.slug, personId, otherId, inB };
}

/** The tables of the test's schema with a row that holds `needle`, any case, outside workspace `except`. */
async function tablesHolding(needle: string, except: string): Promise<string[]> {
  const owner = asRole("owner");
  const tables = await owner.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const holding: string[] = [];
  for (const { name } of tables) {
    const [row] = await owner.$queryRawUnsafe<{ found: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM "${name}" t
        WHERE strpos(lower(to_jsonb(t)::text), lower($1)) > 0
          AND (to_jsonb(t) ->> 'workspace_id') IS DISTINCT FROM $2) AS found`,
      needle,
      except,
    );
    if (row?.found) holding.push(name);
  }
  return holding;
}

/** Every row of every table of the test's schema, as JSON text, by table. */
async function everyRow(): Promise<Record<string, string[]>> {
  const owner = asRole("owner");
  const tables = await owner.$queryRaw<{ name: string }[]>`
    SELECT table_name AS name FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    const found = await owner.$queryRawUnsafe<{ row: string }[]>(
      `SELECT to_jsonb(t)::text AS row FROM "${name}" t ORDER BY 1`,
    );
    rows[name] = found.map(({ row }) => row);
  }
  return rows;
}

const count = (workspaceId: string, fn: (tx: TenantClient) => Promise<number>) =>
  inRun(workspaceId, fn);

test("pnpm erase by URL deletes every row that names the person, keeps the hash and the log, prints the counts", async () => {
  const { A, B, slug, personId, otherId, inB } = await fixture();
  // The scan finds what it looks for: the person's name in the modules' rows, before the erasure.
  const before = await tablesHolding("marrowcliffe", B);
  for (const table of [
    "persons",
    "decision_records",
    "evidence",
    "message_drafts",
    "score_snapshots",
  ]) {
    assert.ok(before.includes(table), `${table} holds the name before the erasure`);
  }
  assert.ok((await tablesHolding(personId, B)).includes("outbox"));

  const printed: string[] = [];
  const url = `HTTPS://LinkedIn.com/in/${SLUG.toUpperCase()}?utm_source=request`;
  const args = ["--workspace", slug, "--linkedin-url", url, "--operator", OPERATOR];
  assert.equal(await runErase(args, (line) => printed.push(line)), 0);
  assert.deepEqual(printed.slice(0, -1), COUNTS);
  assert.match(printed.at(-1) ?? "", /^erased: era_[0-9A-Z]{26}, 25 rows$/);
  for (const value of [personId, ...NAMES]) {
    assert.ok(
      !printed.join("\n").toLowerCase().includes(value.toLowerCase()),
      "prints no person data",
    );
  }

  // Every table: the id in the two that keep it, the name and the URL nowhere.
  assert.deepEqual(await tablesHolding(personId, B), KEEP_ID);
  for (const needle of NAMES) assert.deepEqual(await tablesHolding(needle, B), [], needle);

  // The log row: the URL's erased hash, the counts by module, the operator; nothing else of the person.
  const logs = await inRun(A, (tx) => tx.erasureLog.findMany());
  assert.equal(logs.length, 1);
  const [log] = logs as [(typeof logs)[number]];
  assert.equal(`erased: ${log.id}, 25 rows`, printed.at(-1));
  const hashes = await inRun(A, (tx) => tx.personHash.findMany({ where: { kind: "erased" } }));
  assert.equal(hashes.length, 2, "the URL's hash and the provider id's");
  assert.ok(hashes.some((row) => row.hash === log.personHash));
  assert.equal(log.performedBy, OPERATOR);
  assert.ok(log.requestedAt <= log.completedAt);
  // jsonb keeps its own key order: the counts compare as objects.
  const byModule: Record<string, Record<string, number>> = {};
  for (const line of COUNTS) {
    const [, module, table, n] = /^(\w+)\.(\w+): (\d+)$/.exec(line) as unknown as string[];
    byModule[module as string] = { ...byModule[module as string], [table as string]: Number(n) };
  }
  assert.deepEqual(log.counts, byModule);

  // The other person keeps its rows, its event of two persons keeps it alone; workspace B keeps all.
  const kept = (workspaceId: string, id: string) =>
    Promise.all([
      count(workspaceId, (tx) => tx.lead.count({ where: { personId: id } })),
      count(workspaceId, (tx) => tx.scoreSnapshot.count({ where: { personId: id } })),
      count(workspaceId, (tx) => tx.signalEvent.count({ where: { personId: id } })),
      count(workspaceId, (tx) => tx.messageDraft.count({ where: { personId: id } })),
      count(workspaceId, (tx) => tx.decisionRecord.count({ where: { subjectRef: id } })),
    ]);
  assert.deepEqual(await kept(A, otherId), [1, 1, 2, 2, 3]);
  assert.deepEqual(await kept(B, inB), [1, 1, 2, 2, 3]);
  const events = await inRun(A, (tx) => tx.outboxEntry.findMany({ orderBy: { eventName: "asc" } }));
  assert.deepEqual(
    events.map((row) => [row.eventName, row.payload]),
    [
      ["contacts.lead_reviewed", { workspaceId: A, personId: otherId, decision: "good_lead" }],
      ["signals.person_found", { workspaceId: A, personIds: [otherId] }],
    ],
  );
});

test("a later import or signal run meets the erased hash and skips the person", async () => {
  const { A, B, personId } = await fixture();
  const args = ["--workspace", A, "--person", personId, "--operator", OPERATOR];
  assert.equal(await runErase(args, () => {}), 0);
  await inRun(A, async () => {
    // What an import's and a signal run's selection read first (discovery's run.ts, signals' select.ts).
    const byUrl = await isHashed({ linkedinUrls: [PROFILE.linkedinUrl] });
    const byId = await isHashed({ providerIds: [MEMBER] });
    assert.deepEqual([byUrl.get(PROFILE.linkedinUrl), byId.get(MEMBER)], ["erased", "erased"]);
    // And the commands they write the person with: the batch an import's chunk calls, and the one a
    // signal run calls, by the URL or by the provider id alone.
    const input = { source: "linkedin", provider: "unipile", profile: PROFILE } as const;
    assert.deepEqual(await upsertPersonsFromSource([input]), [{ code: "person_erased" }]);
    await assert.rejects(upsertPersonFromSource(input), { code: "person_erased" });
    const renamed = { ...PROFILE, linkedinUrl: "https://linkedin.com/in/ysolde-m-new" };
    await assert.rejects(upsertPersonFromSource({ ...input, profile: renamed }), {
      code: "person_erased",
    });
  });
  assert.deepEqual(await tablesHolding("marrowcliffe", B), [], "nothing was written");
});

test("the dry run prints the same counts and changes nothing", async () => {
  const { A, personId } = await fixture();
  const before = await everyRow();
  const printed: string[] = [];
  const args = ["--workspace", A, "--person", personId, "--operator", OPERATOR];
  assert.equal(await runErase([...args, "--dry-run"], (line) => printed.push(line)), 0);
  assert.deepEqual(printed, [...COUNTS, "dry_run: 25 rows counted, all rolled back"]);
  assert.deepEqual(await everyRow(), before);
  const erased: string[] = [];
  assert.equal(await runErase(args, (line) => erased.push(line)), 0);
  assert.deepEqual(erased.slice(0, -1), printed.slice(0, -1));
});

test("an eraser that fails rolls every row back", async () => {
  const { A, personId } = await fixture();
  const before = await everyRow();
  const failing = {
    module: "zz_failing",
    dependsOn: [],
    erase: async () => {
      throw new Error("the eraser failed");
    },
  };
  const request = { workspaceId: A, person: { id: personId }, operator: OPERATOR, dryRun: false };
  // After every registered eraser, before contacts': their deletes are in the run, and roll back.
  const erasers = [...registeredErasers(), failing];
  await assert.rejects(erase(request, erasers), /the eraser failed/);
  assert.deepEqual(await everyRow(), before);
});

test("the command refuses a usage error, an unknown workspace or person and a bad URL, printing no input", async () => {
  const { A, slug } = await fixture();
  const printed: string[] = [];
  const run = (args: string[]) => runErase(args, (line) => printed.push(line));
  const url = PROFILE.linkedinUrl;
  assert.equal(await run(["--workspace", A, "--person", "per_x"]), 2, "no operator");
  assert.equal(await run(["--workspace", A, "--operator", OPERATOR]), 2, "no person");
  const both = ["--workspace", A, "--person", "per_x", "--linkedin-url", url, "--operator", "me"];
  assert.equal(await run(both), 2, "a person twice");
  assert.equal(await run(["--workspace", A, "--person", "per_x", "--operator", " "]), 2);
  assert.ok(printed.every((line) => line.startsWith("usage: pnpm erase")));
  printed.length = 0;
  const unknown = "w000000000000";
  assert.equal(await run(["--workspace", unknown, "--person", "per_x", "--operator", "me"]), 1);
  assert.equal(await run(["--workspace", slug, "--person", "per_unknown7", "--operator", "me"]), 1);
  const missing = "https://linkedin.com/in/nobody-here-3x";
  assert.equal(await run(["--workspace", slug, "--linkedin-url", missing, "--operator", "me"]), 1);
  const bad = "https://example.com/in/ysolde";
  assert.equal(await run(["--workspace", slug, "--linkedin-url", bad, "--operator", "me"]), 1);
  assert.deepEqual(printed, [
    `workspace_not_found: no single workspace has the slug ${unknown}: pass its id`,
    "person_not_found",
    "person_not_found",
    "linkedin_url_invalid",
  ]);
  assert.equal(await inRun(A, (tx) => tx.erasureLog.count()), 0);
});

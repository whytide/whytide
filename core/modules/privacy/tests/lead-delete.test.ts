// `pnpm lead:delete` end to end on the worktree's database (README.md "Deleting a lead"). The fixture
// is the owner's case: a lead a member added by hand (contacts' createLeadByMember, the Add lead
// form's command), stopped by the title filter (an assessment attempt), approved into the campaign,
// its connection request scheduled with its approved item and message_1 awaiting approval with its
// pending item and draft, linkedin's read of the profile and the approval's outbox event; never
// contacted. The command deletes every row that names the person, writes no erased hash and a log
// row `lead_deleted` without one, and the member can add the same URL again. The dry run changes
// nothing. A touch, a step sent or claimed, an outreach row or a thread refuses it as
// person_contacted, an opt-out as person_suppressed, each changing nothing. The guard locks the
// person's enrollment and steps before every other eraser. `pnpm erase` still keeps the hash, and
// the same URL is then refused. A lead known by an email address alone (gamma-rf-050) is deleted by
// the address, `--email`, printed and kept nowhere, and the same address adds them again.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApprovalItem } from "@whytide/approvals/testing";
import { createEnrollment } from "@whytide/campaigns/testing";
import {
  addOptOut,
  createLeadForPerson,
  recordLeadStatus,
  recordTouch,
  upsertPersonFromSource,
} from "@whytide/contacts";
import { createLeadByMember, useHashSalt } from "@whytide/contacts/testing";
import { type TenantClient, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createThread } from "@whytide/inbox/testing";
import { type Principal, servicePrincipal } from "@whytide/platform";
import { createOrganizationWithWorkspace, useTenancyClient } from "@whytide/tenancy/testing";
import { runErase } from "../cli/erase.ts";
import { runLeadDelete } from "../cli/lead-delete.ts";
import { useClient } from "../domain/client.ts";
import { registeredErasers } from "../domain/erase/registry.ts";
import { deleteLead } from "../domain/lead-delete/delete.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useClient(asRole("app"));
useTenancyClient(asRole("app"));

const service = servicePrincipal("privacy_test");
/** The member who adds the lead on the Add lead form, and approves it. */
const MEMBER: Principal = {
  userId: "usr_lead_adder",
  actorType: "human",
  authMethod: "session",
  scopes: [],
};
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>, principal = service) =>
  withTenant({ workspaceId, principal }, fn, { client: asRole("app") });

/** The lead as the member types it, synthetic. */
const SLUG = "wendeline-oakhurst-5k9";
const LEAD = {
  linkedinUrl: `https://www.linkedin.com/in/${SLUG}/`,
  firstName: "Wendeline",
  lastName: "Oakhurst",
  title: "Talent Partner",
};
const NAMES = ["wendeline", "oakhurst", SLUG];
const OPERATOR = "owner@example.com";
const SENDER = "sac_fixture";

const COUNTS = [
  "platform.outbox: 1",
  "platform.idempotency_records: 0",
  "approvals.approval_items: 2",
  "enrichment.enrichment_runs: 0",
  "enrichment.contact_points: 0",
  "enrichment.enrichment_requests: 0",
  "enrichment.enrichment_cache_entries: 0",
  "inbox.messages: 0",
  "inbox.threads: 0",
  "linkedin.sender_outreach: 0",
  "linkedin.sender_action_log: 1",
  "messaging.message_drafts: 1",
  "campaigns.step_executions: 4",
  "campaigns.enrollments: 1",
  "qualification.score_snapshots: 0",
  "qualification.criterion_verdicts: 0",
  "qualification.assessment_attempts: 1",
  "qualification.intent_scores: 0",
  "signals.signal_events: 0",
  "signals.evidence: 0",
  "signals.decision_records: 0",
  "ai.decision_records: 1",
  "contacts.person_email_hashes: 0",
  "contacts.review_decisions: 0",
  "contacts.leads: 1",
  "contacts.persons: 1",
];

let made = 0;
const idOf = (prefix: string) => `${prefix}_fixture${++made}`;

/** The owner's case in a workspace of its own; the workspace, its slug and the person's id. */
async function addedByHand() {
  const { workspace } = await createOrganizationWithWorkspace();
  const workspaceId = workspace.id;
  const personId = await inRun(workspaceId, () => createLeadByMember(LEAD), MEMBER);
  await inRun(workspaceId, async (tx) => {
    // The title filter's answer, as qualification leaves it, then the member's approval.
    await tx.assessmentAttempt.create({
      data: { workspaceId, personId, icpId: "icp_test", icpVersion: 1, attempt: 1 },
    });
    await tx.lead.update({
      where: { personId },
      data: { qualificationStatus: "hard_filtered", hardFilterReason: "title_mismatch" },
    });
    await recordLeadStatus(personId, "approved", { actor: { type: "user", id: MEMBER.userId } });
    await recordLeadStatus(personId, "in_campaign", { actor: { type: "system" } });
    const later = new Date(Date.now() + 3_600_000);
    const { stepIds } = await createEnrollment(
      {
        ...{ workspaceId, personId, senderAccountId: SENDER },
        steps: [
          { stepKey: "connect", status: "scheduled", scheduledFor: later },
          { stepKey: "message_1", status: "awaiting_approval" },
          { stepKey: "follow_up_1", status: "planned" },
          { stepKey: "follow_up_2", status: "planned" },
        ],
      },
      tx,
    );
    const [connect, message1] = stepIds as [string, string];
    const item = { workspaceId, personId, senderAccountId: SENDER };
    await createApprovalItem(
      { ...item, stepExecutionId: connect, stepKey: "connect", status: "approved" },
      tx,
    );
    await createApprovalItem({ ...item, stepExecutionId: message1 }, tx);
    const decisionRecordId = idOf("dec");
    await tx.decisionRecord.create({
      data: {
        ...{ id: decisionRecordId, workspaceId, task: "messaging.write-message" },
        ...{ subjectRef: personId, modelId: "fake-model", promptVersion: 1 },
        ...{ inputHash: idOf("hash"), status: "ok", output: {}, gates: [], latencyMs: 1 },
        ...{ inputTokens: 1, outputTokens: 1, costCredits: 0, attempts: 1 },
        rawPrompt: `The profile: ${LEAD.firstName} ${LEAD.lastName}, ${LEAD.linkedinUrl}`,
        rawOutput: `Hi ${LEAD.firstName}`,
        rawPurgeAfter: new Date(Date.now() + 86_400_000),
      },
    });
    await tx.messageDraft.create({
      data: {
        ...{ id: idOf("mdr"), workspaceId, personId, channel: "linkedin_message" },
        ...{ kind: "outbound_step", stepExecutionId: message1, stepKey: "message_1" },
        ...{ status: "ready", text: `Hi ${LEAD.firstName}, a question`, decisionRecordId },
      },
    });
    await tx.senderActionLog.create({
      data: {
        ...{ id: idOf("sal"), workspaceId, senderAccountId: SENDER, kind: "read_profile" },
        ...{ objectRef: personId, count: 1, outcome: "ok", at: new Date() },
      },
    });
    await tx.outboxEntry.create({
      data: {
        ...{ id: idOf("evt"), workspaceId, eventName: "contacts.lead_approved" },
        payload: { workspaceId, personId, approvedBy: MEMBER.userId },
      },
    });
  });
  return { workspaceId, slug: workspace.slug, personId };
}

/** The tables of the test's schema with a row that holds `needle`, any case. */
async function tablesHolding(needle: string): Promise<string[]> {
  const holding: string[] = [];
  for (const [name, rows] of Object.entries(await everyRow())) {
    if (rows.some((row) => row.toLowerCase().includes(needle.toLowerCase()))) holding.push(name);
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

const argsFor = (workspace: string, personId: string) => [
  ...["--workspace", workspace, "--person", personId, "--operator", OPERATOR],
];

test("pnpm lead:delete deletes every row of a lead never contacted, keeps no hash, and the member adds the URL again", async () => {
  const { workspaceId, slug, personId } = await addedByHand();
  const printed: string[] = [];
  const url = `https://linkedin.com/in/${SLUG.toUpperCase()}?utm_source=share`;
  const args = ["--workspace", slug, "--linkedin-url", url, "--operator", OPERATOR];
  assert.equal(await runLeadDelete(args, (line) => printed.push(line)), 0);
  assert.deepEqual(printed.slice(0, -1), COUNTS);
  assert.match(printed.at(-1) ?? "", /^deleted: era_[0-9A-Z]{26}, 14 rows$/);
  for (const value of [personId, ...NAMES]) {
    assert.ok(!printed.join("\n").toLowerCase().includes(value.toLowerCase()), "no person data");
  }
  // Every table: the id, the name and the URL nowhere; the log row without a hash, and none erased.
  for (const needle of [personId, ...NAMES]) assert.deepEqual(await tablesHolding(needle), []);
  const logs = await inRun(workspaceId, (tx) => tx.erasureLog.findMany());
  assert.deepEqual(
    logs.map((row) => [`deleted: ${row.id}, 14 rows`, row.reason, row.personHash, row.performedBy]),
    [[printed.at(-1), "lead_deleted", null, OPERATOR]],
  );
  const erased = { where: { kind: "erased" as const } };
  assert.equal(await inRun(workspaceId, (tx) => tx.personHash.count(erased)), 0);

  // The Add lead form's command takes the same URL again: a new person with a new lead.
  const again = await inRun(workspaceId, () => createLeadByMember(LEAD), MEMBER);
  assert.notEqual(again, personId);
  const leads = await inRun(workspaceId, (tx) => tx.lead.findMany({ where: { personId: again } }));
  assert.deepEqual(
    leads.map((lead) => [lead.qualificationStatus, lead.outreachStatus, lead.sourceLabel]),
    [["pending", "pending_review", "manual"]],
  );
});

test("the dry run prints the same lines and changes nothing", async () => {
  const { workspaceId, personId } = await addedByHand();
  const before = await everyRow();
  const printed: string[] = [];
  const args = [...argsFor(workspaceId, personId), "--dry-run"];
  assert.equal(await runLeadDelete(args, (line) => printed.push(line)), 0);
  assert.deepEqual(printed, [...COUNTS, "dry_run: 14 rows counted, all rolled back"]);
  assert.deepEqual(await everyRow(), before);
});

/** What makes the person contacted or suppressed, written in a run of the workspace, and the code. */
const REFUSALS: readonly (readonly [
  string,
  string,
  (workspaceId: string, personId: string, tx: TenantClient) => Promise<unknown>,
])[] = [
  ["a touch", "person_contacted", (_, personId) => recordTouch(personId, new Date())],
  [
    "a connection request sent",
    "person_contacted",
    (_, personId, tx) =>
      tx.stepExecution.updateMany({
        where: { personId, stepKey: "connect" },
        data: { status: "succeeded", executedAt: new Date() },
      }),
  ],
  [
    "a step the sender claimed",
    "person_contacted",
    (_, personId, tx) =>
      tx.stepExecution.updateMany({
        where: { personId, stepKey: "connect" },
        data: { status: "executing" },
      }),
  ],
  [
    "an outreach row",
    "person_contacted",
    (workspaceId, personId, tx) =>
      tx.senderOutreach.create({
        data: { id: idOf("sor"), workspaceId, senderAccountId: SENDER, personId },
      }),
  ],
  [
    "an inbox thread",
    "person_contacted",
    (workspaceId, personId, tx) =>
      createThread({ workspaceId, personId, senderAccountId: SENDER }, tx),
  ],
  [
    "an opt-out",
    "person_suppressed",
    (_, personId) => addOptOut(personId, { source: "manual", createdBy: MEMBER.userId }),
  ],
];

for (const [what, code, write] of REFUSALS) {
  test(`${what} refuses the deletion as ${code}, printed alone, and nothing changes`, async () => {
    const { workspaceId, personId } = await addedByHand();
    await inRun(workspaceId, (tx) => write(workspaceId, personId, tx));
    const before = await everyRow();
    const printed: string[] = [];
    for (const dryRun of [[], ["--dry-run"]]) {
      const args = [...argsFor(workspaceId, personId), ...dryRun];
      assert.equal(await runLeadDelete(args, (line) => printed.push(line)), 1);
    }
    assert.deepEqual(printed, [code, code]);
    assert.deepEqual(await everyRow(), before);
  });
}

test("the guard locks the person's enrollment and steps after the platform's step, before every other eraser", async () => {
  const { workspaceId, personId } = await addedByHand();
  const owner = asRole("owner");
  const seen: string[] = [];
  // Another transaction may not take them: SKIP LOCKED skips the rows while the run holds them, as
  // the sender's claim of the connection request waits for them.
  const probed = registeredErasers().map((eraser) => ({
    ...eraser,
    erase: async (id: string) => {
      const free = [
        ...(await owner.$queryRaw<unknown[]>`
          SELECT 1 FROM enrollments WHERE person_id = ${personId} FOR UPDATE SKIP LOCKED`),
        ...(await owner.$queryRaw<unknown[]>`
          SELECT 1 FROM step_executions WHERE person_id = ${personId} FOR UPDATE SKIP LOCKED`),
      ];
      seen.push(`${eraser.module}: ${free.length === 0 ? "locked" : `${free.length} free`}`);
      return eraser.erase(id);
    },
  }));
  const request = { workspaceId, person: { id: personId }, operator: OPERATOR, dryRun: true };
  const counted = await deleteLead(request, probed);
  assert.ok(!("skipped" in counted) && counted.logId === null);
  const others = probed.map(({ module }) => module).filter((module) => module !== "platform");
  assert.deepEqual(seen, ["platform: 5 free", ...others.map((module) => `${module}: locked`)]);
});

test("pnpm erase still keeps the erased hash: the same URL is then refused", async () => {
  const { workspaceId, personId } = await addedByHand();
  const printed: string[] = [];
  assert.equal(await runErase(argsFor(workspaceId, personId), (line) => printed.push(line)), 0);
  assert.deepEqual(printed.slice(0, -1), COUNTS);
  assert.match(printed.at(-1) ?? "", /^erased: era_[0-9A-Z]{26}, 14 rows$/);
  const logs = await inRun(workspaceId, (tx) => tx.erasureLog.findMany());
  assert.deepEqual(
    logs.map((row) => [row.reason, row.personHash === null]),
    [["request", false]],
  );
  await assert.rejects(
    inRun(workspaceId, () => createLeadByMember(LEAD), MEMBER),
    {
      code: "person_erased",
    },
  );
});

test("the command refuses a usage error and an unknown person, printing no input", async () => {
  const { workspaceId } = await addedByHand();
  const printed: string[] = [];
  const run = (args: string[]) => runLeadDelete(args, (line) => printed.push(line));
  assert.equal(await run(["--workspace", workspaceId, "--person", "per_x"]), 2, "no operator");
  assert.equal(await run(["--workspace", workspaceId, "--operator", OPERATOR]), 2, "no person");
  assert.ok(printed.every((line) => line.startsWith("usage: pnpm lead:delete --workspace")));
  printed.length = 0;
  assert.equal(await run(argsFor(workspaceId, "per_unknown7")), 1);
  const missing = ["--linkedin-url", "https://linkedin.com/in/nobody-here-3x"];
  assert.equal(await run(["--workspace", workspaceId, ...missing, "--operator", OPERATOR]), 1);
  assert.deepEqual(printed, ["person_not_found", "person_not_found"]);
  assert.equal(await inRun(workspaceId, (tx) => tx.erasureLog.count()), 0);
});

test("pnpm lead:delete --email deletes a lead without a LinkedIn profile, keeps no hash, and the same address adds them again", async () => {
  const { workspace } = await createOrganizationWithWorkspace();
  const workspaceId = workspace.id;
  const address = "noor.vellacourt@fenwater.example";
  const input = {
    source: "import",
    provider: "csv",
    profile: { email: address, firstName: "Noor", lastName: "Vellacourt" },
  } as const;
  const personId = await inRun(workspaceId, async () => {
    const { person } = await upsertPersonFromSource(input);
    await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sig_1" } });
    return person.id;
  });
  const printed: string[] = [];
  const args = ["--workspace", workspaceId, "--email", ` ${address.toUpperCase()}`];
  assert.equal(
    await runLeadDelete([...args, "--operator", OPERATOR], (line) => printed.push(line)),
    0,
  );
  assert.ok(printed.includes("contacts.person_email_hashes: 1"));
  assert.match(printed.at(-1) ?? "", /^deleted: era_[0-9A-Z]{26}, \d+ rows$/);
  const text = printed.join("\n").toLowerCase();
  for (const value of [address, "vellacourt", personId.toLowerCase()]) {
    assert.ok(!text.includes(value), "prints no person data");
  }
  for (const needle of [personId, address, "vellacourt"]) {
    assert.deepEqual(await tablesHolding(needle), [], needle);
  }
  const logs = await inRun(workspaceId, (tx) => tx.erasureLog.findMany());
  assert.deepEqual(
    logs.map((row) => [row.reason, row.personHash]),
    [["lead_deleted", null]],
  );
  const erased = { where: { kind: "erased" as const } };
  assert.equal(await inRun(workspaceId, (tx) => tx.personHash.count(erased)), 0);

  // No hash: the same address makes a new person.
  const again = await inRun(workspaceId, () => upsertPersonFromSource(input));
  assert.equal(again.created, true);
  assert.notEqual(again.person.id, personId);
});

// signals' triage end to end (signals-triage-ai; core/modules/signals/README.md "Triage"), on the
// slice's Temporal and a schema of its database: credits, linkedin and signals loaded from their
// builds by the worker's own loader, on the LinkedIn, files and LLM fakes, linkedin's clock a working
// Wednesday at 10:00 UTC. The code drops come first, unchanged: the own staff, a competitor's staff,
// a hash and a known engagement. The agent skips a recruiter against an ICP without recruiters and
// keeps an agency's founder for an ICP with Agency Owner, and the profiles are read in its order:
// the commenter, then the reactors it reads first (a combined title among them, staged after an
// unrelated one), then the rest. After the read, a recruiter's profile is a pending lead and a
// competitor's staff is dropped. The model receives no name, profile URL or member reference, and
// the history, the log lines and the outbox hold no headline or name. A triage that ends ai_failed,
// and a model failing past the step's attempts, each decide the batch by the rules: the recruiter
// terms (an agency's founder among them) and the title rule's rank; the run reads on. The first
// run's history is workflows/__histories__/signals_run_triaged.json (history:record).
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Context } from "@temporalio/activity";
import { historyToJSON } from "@temporalio/common/lib/proto-utils.js";
import type { TenantClient } from "@whytide/db";
import type { FakeEngager as Engager, LinkedinFake, LlmFake } from "@whytide/providers";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";
process.env.PROVIDER_LLM = "fake";

const { loadAgentTasks } = await import("@whytide/ai");
const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, linkedinPort, llmPort } = await import("@whytide/providers");
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const contacts = await built("contacts/dist/index.js");
const { useHashSalt } = await built("contacts/dist/testing/index.js");
const { readIcpForScoring } = await built("icp/dist/index.js");
const linkedin = await built("linkedin/dist/testing/index.js");
const signals = await built("signals/dist/testing/index.js");
const tenancy = await built("tenancy/dist/testing/index.js");

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
signals.useSignalsClient(db());
linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
useHashSalt("test-salt-".repeat(4));
await loadAgentTasks();
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const llm = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
const principal = platform.servicePrincipal("signals_test");
const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: db() });
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
/** The ICP: no recruiter, no job seeker, but agency owners. */
const ICP = {
  titles: ["Revenue Operations Manager", "Agency Owner"],
  seniorities: ["manager", "owner_founder"],
  industries: ["Software"],
  sizeRanges: ["51-200"],
  countries: ["DE"],
};
const COMPANY = {
  companyName: "Blue Harbor Labs",
  companyUrl: "https://www.linkedin.com/company/blue-harbor",
};
const RIVAL = {
  companyName: "Rival Corp",
  companyUrl: "https://www.linkedin.com/company/rival-corp",
};
let posts = 0;

type More = {
  reaction?: Engager["reaction"];
  commentText?: string;
  profile?: Record<string, string> | null;
};
/**
 * An engager `slug`, an hour and `at` minutes ago, with its name and headline, a like unless said;
 * its profile, a German one at Blue Harbor Labs, seeded unless `profile` is null.
 */
function engager(
  slug: string,
  at: number,
  name: string,
  headline: string,
  more: More = {},
): Engager {
  const profileUrl = `https://www.linkedin.com/in/${slug}`;
  const { reaction = "like", commentText, profile = {} } = more;
  if (profile !== null) {
    const [firstName = "", lastName = ""] = name.split(" ");
    const base = { providerMemberRef: slug, profileUrl, firstName, lastName, headline };
    const where = { title: "Operations", locationText: "Berlin, Germany", ...COMPANY };
    fake.seedProfile({ ...base, ...where, ...profile });
  }
  const engagedAt = new Date(Date.now() - 3_600_000 - at * 60_000);
  const words = commentText === undefined ? {} : { commentText };
  return { providerMemberRef: slug, profileUrl, name, headline, reaction, engagedAt, ...words };
}

/**
 * A workspace of the organization "Acme Labs" with credits, the ICP, a competitor_engagement source
 * naming Rival Corp, a connected account and a post engagers source on a post the fake seeds.
 */
async function sourceOf(seeded: Engager[]) {
  const writer = asRole("billing_writer");
  for (const [action, unit] of [
    ["signals.engager", "engager"],
    ["signals.engager_read", "engagers_30"],
  ] as const) {
    await writer.priceListEntry.createMany({
      data: {
        id: platform.newId(creditsIds.price_list_entry),
        ...{ action, credits: 1, unit, version: 1, effectiveFrom: new Date(Date.now() - 60_000) },
      },
      skipDuplicates: true,
    });
  }
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId: string = tenant.workspace.id;
  await db().organization.update({
    where: { id: tenant.organization.id },
    data: { name: "Acme Labs" },
  });
  await grantAllowance([tenant.organization.id], 100);
  await inRun(workspaceId, async (tx) => {
    const { id } = (await readIcpForScoring(workspaceId)).icp;
    await tx.icp.update({ where: { id }, data: ICP });
  });
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  posts += 1;
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}${posts}`;
  fake.seedPost(postUrl, seeded);
  const created = { senderAccountId: account.id, createdBy: tenant.user.id };
  const source = await db().signalSource.create({
    data: {
      id: platform.newId("src"),
      ...{ workspaceId, kind: "post_engagers", config: { postUrl }, label: "Launch post" },
      ...created,
    },
  });
  await db().signalSource.create({
    data: {
      id: platform.newId("src"),
      ...{ workspaceId, kind: "competitor_engagement", config: RIVAL, label: "Rival" },
      ...{ ...created, enabled: false },
    },
  });
  return { workspaceId, sourceId: source.id, postUrl };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;
type RunResult = { runId: string; status: string };

/** A run of the source, and the id of its workflow. */
async function run(source: Source) {
  let workflowId = "";
  const signals_run_start = async (input: never) => {
    workflowId = Context.current().info.workflowExecution?.workflowId ?? "";
    return activities.signals_run_start?.(input);
  };
  const input = { workspaceId: source.workspaceId, sourceId: source.sourceId };
  const all = { activities: { ...activities, signals_run_start } };
  return { ...(await runWorkflow<RunResult>("signals_run", input, all)), workflowId };
}
const countsOf = async (runId: string) =>
  (await db().signalRun.findUniqueOrThrow({ where: { id: runId } })).counts;
/** The engagers whose profiles were read, by their slug, in the order of the reads. */
const readOrder = (seeded: readonly Engager[]) =>
  fake.recordedCalls
    .filter(({ method }) => method === "getProfile")
    .map(({ input }) => (input as { profileUrl: string }).profileUrl)
    .flatMap((url) => seeded.filter((one) => one.profileUrl === url).map((one) => one.name));
/** What each model call received, as JSON. */
const sent = () =>
  llm.recordedCalls
    .filter(({ method }) => method === "model")
    .map(({ input }) => JSON.stringify(input));
/** The payloads of the workflow's history, decoded. */
async function historyOf(workflowId: string): Promise<string> {
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const decoded: string[] = [];
  JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const { data, metadata } = (value ?? {}) as { data?: unknown; metadata?: unknown };
    if (typeof data === "string" && metadata) decoded.push(Buffer.from(data, "base64").toString());
    return value;
  });
  return decoded.join("\n");
}
const decide = (index: number, decision: string, code: string | null = null) => ({
  ...{ index, decision, code },
});

test("the agent triages a run's engagers after the code drops, which are unchanged: a recruiter skipped against an ICP without recruiters, an agency's founder read for an ICP with Agency Owner, the commenter read first, then the matching titles, a combined one staged after an unrelated reactor among them, then the rest; after the read a recruiter's profile is a pending lead and a competitor's staff dropped; no name, URL or member id reaches the model, and no headline or name the history, the logs or the outbox", async (t) => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const seeded = [
    engager("triage-own", 0, "Owen Marsh", "Sales at Acme Labs", { profile: null }),
    engager("triage-rival", 1, "Rhea Vance", "AE at Rival Corp", { profile: null }),
    engager("triage-hashed", 2, "Hugo Brandt", "Head of RevOps", { profile: null }),
    engager("triage-known", 3, "Kira Holm", "Revenue Operations Manager", { profile: null }),
    engager("triage-barista", 4, "Mara Quill", "Mara Quill | Barista at Bean Bar"),
    engager("triage-revops", 5, "Theo Brandvold", "RevOps & GTM Lead"),
    engager("triage-recruiter", 6, "Ruth Calder", "Technical Recruiter | SaaS", { profile: null }),
    engager("triage-founder", 7, "Fenna Doyle", "Founder, XYZ Staffing"),
    engager("triage-commenter", 8, "Cato Wren", "Head of Finance", {
      ...{ reaction: "comment", commentText: "We forecast in spreadsheets still" },
    }),
    engager("triage-talent", 9, "Tamsin Reyes", "People & Culture", {
      profile: { title: "Talent Acquisition Lead" },
    }),
    engager("triage-rival-staff", 10, "Sol Varga", "Account Executive", { profile: RIVAL }),
  ];
  const source = await sourceOf(seeded);
  await inRun(source.workspaceId, async () => {
    const rejected = { providerId: "triage-hashed", kind: "rejected_candidate" as const };
    await contacts.recordHash({ ...rejected, dropReasons: ["country_mismatch"] });
  });
  // The engagement the workspace knows: an event of its dedupe key (rules.ts's dedupeKeyOf).
  const parts = ["post_engagement", "triage-known", source.postUrl, "like"];
  const dedupeKey = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  const known = await signals.createSignalEvent({
    workspaceId: source.workspaceId,
    personId: "per_known",
  });
  await db().signalEvent.update({ where: { id: known.id }, data: { dedupeKey } });
  // The batch after the code drops, in the staged order: the barista, the revops lead, the
  // recruiter, the founder, the commenter, the talent lead and the rival's staff.
  llm.script({
    decisions: [
      ...[decide(1, "read"), decide(2, "read_first"), decide(3, "skip", "recruiter")],
      ...[decide(4, "read_first"), decide(5, "read"), decide(6, "read"), decide(7, "read")],
    ],
  });
  const result = await run(source);
  // The run whose history is workflows/__histories__/signals_run_triaged.json (history:record).
  t.diagnostic(`signals_run ran as ${result.workflowId}`);
  assert.equal(result.status, "done");
  assert.deepEqual(await countsOf(result.runId), {
    ...{ pages: 1, read: 11, staged: 11, created: 5, profiles_read: 6 },
    ...{ dropped_own: 1, dropped_competitor: 2, dropped_hashed: 1, dropped_known: 1 },
    dropped_triage: 1,
  });
  // The commenter, then read_first in the staged order, then read: no read for the code drops or
  // the recruiter the agent skipped.
  assert.deepEqual(readOrder(seeded), [
    ...["Cato Wren", "Theo Brandvold", "Fenna Doyle"],
    ...["Mara Quill", "Tamsin Reyes", "Sol Varga"],
  ]);
  // After the read: the talent lead, a recruiter by the title, is a pending lead; the rival's staff
  // is dropped by its company, with no hash.
  const where = { workspaceId: source.workspaceId };
  const persons = await db().person.findMany({ where });
  const leads = await db().lead.findMany({ where });
  const talent = persons.find((person) => person.title === "Talent Acquisition Lead");
  assert.ok(talent, "the talent acquisition lead is a person");
  const pending = leads.filter((lead) => lead.personId === talent.id);
  assert.deepEqual(
    pending.map((lead) => lead.qualificationStatus),
    ["pending"],
  );
  assert.equal(persons.length, 5);
  assert.ok(!persons.some((person) => person.companyName === RIVAL.companyName));
  assert.equal(await db().personHash.count({ where }), 1);
  // One model call: the ICP and the headlines scrubbed, nothing that names a person.
  const [call = "", ...more] = sent();
  assert.deepEqual(more, []);
  for (const shown of [
    "RevOps & GTM Lead",
    "[name] [name] | Barista at Bean Bar",
    "Agency Owner",
  ]) {
    assert.ok(call.includes(shown), `the model did not receive ${shown}`);
  }
  const named = seeded.flatMap(({ name, profileUrl, providerMemberRef }) => [
    ...name.split(" "),
    ...[profileUrl, providerMemberRef],
  ]);
  for (const value of [...named, "linkedin.com/in", "Sales at Acme Labs", "AE at Rival Corp"]) {
    assert.ok(!call.includes(value), `the model received ${value}`);
  }
  const records = await db().decisionRecord.findMany({ where });
  assert.deepEqual(
    records.map(({ task, subjectRef, status }) => [task, subjectRef, status]),
    [["signals.triage-engagers", source.workspaceId, "ok"]],
  );
  // No headline or name in the history, a log line or an outbox event.
  const history = await historyOf(result.workflowId);
  assert.ok(history.includes("headline-triage"), "no patch marker");
  const outbox = await db().outboxEntry.findMany({ where });
  const texts = [history, logs.raw.join("\n"), JSON.stringify(outbox.map((e) => e.payload))];
  for (const { name, headline } of seeded) {
    for (const value of [name, headline]) {
      for (const text of texts)
        assert.ok(!text.includes(value), `${value} is in a history, a log line or an event`);
    }
  }
  linkedin.useClock(undefined);
});

/** The fallback's engagers: by the rules, the recruiter and the founder by their headline's terms, then the commenter, the title's match and the rest. */
function fallbackEngagers(prefix: string) {
  return [
    engager(`${prefix}-barista`, 0, "Mara Quill", "Barista"),
    engager(`${prefix}-manager`, 1, "Theo Brandvold", "Revenue Operations Manager at Initech"),
    engager(`${prefix}-recruiter`, 2, "Ruth Calder", "Technical Recruiter", { profile: null }),
    engager(`${prefix}-founder`, 3, "Fenna Doyle", "Founder, XYZ Staffing", { profile: null }),
    engager(`${prefix}-revops`, 4, "Ivo Lund", "RevOps & GTM Lead"),
    engager(`${prefix}-commenter`, 5, "Cato Wren", "Head of Finance", {
      ...{ reaction: "comment", commentText: "We forecast in spreadsheets still" },
    }),
  ];
}
const RULES_ORDER = ["Cato Wren", "Theo Brandvold", "Mara Quill", "Ivo Lund"];
const RULES_COUNTS = {
  ...{ pages: 1, read: 6, staged: 6, created: 4, profiles_read: 4 },
  dropped_recruiter: 2,
};

test("a triage that ends ai_failed, its answer refused twice, decides its batch by the rules: the recruiter terms drop the recruiter and the agency's founder, and the commenter, the title's match and the rest are read in that order; the run reads on and ends done", async () => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const seeded = fallbackEngagers("failed");
  const source = await sourceOf(seeded);
  llm.script({ decisions: [] }, "not JSON");
  const result = await run(source);
  assert.equal(result.status, "done");
  assert.deepEqual(await countsOf(result.runId), RULES_COUNTS);
  assert.deepEqual(readOrder(seeded), RULES_ORDER);
  assert.equal(sent().length, 2);
  const records = await db().decisionRecord.findMany({
    where: { workspaceId: source.workspaceId },
  });
  assert.deepEqual(
    records.map(({ task, status }) => [task, status]),
    [["signals.triage-engagers", "ai_failed"]],
  );
  linkedin.useClock(undefined);
});

test("a model failing past the triage step's three attempts leaves the batch to the rules, and the run reads on and ends done", async () => {
  linkedin.useClock(() => WEDNESDAY);
  llm.reset();
  const seeded = fallbackEngagers("down");
  const source = await sourceOf(seeded);
  for (const _ of [1, 2, 3]) llm.failNext("llm_provider_error");
  const result = await run(source);
  assert.equal(result.status, "done");
  assert.deepEqual(await countsOf(result.runId), RULES_COUNTS);
  assert.deepEqual(readOrder(seeded), RULES_ORDER);
  assert.equal(sent().length, 3);
  const where = { workspaceId: source.workspaceId };
  assert.equal(await db().decisionRecord.count({ where }), 0);
  linkedin.useClock(undefined);
});

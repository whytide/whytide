// signals' run end to end (alpha-p8-020, alpha-p8-030; core/modules/signals/README.md "Runs"), on the
// slice's Temporal and a schema of its database: signals, linkedin and credits loaded from their
// builds by the worker's own loader, their activities through the host's wrapper, on the LinkedIn fake
// and the files fake, set here before the providers load. linkedin's clock (useClock) sets the time
// the read quota reads: a working day at 10:00 UTC, the account's zone. There is no time skipping on
// this Temporal (README "Testing"): a run refused for the cap or the hours waits on a timer until the
// refusal's retryAt, a second at least, and the test moves the quota's clock to the next day or into
// the window while it waits, so the next reservation, the day rolled, is granted. A test replaces an
// activity to see the staging before the last step empties it, or to cancel the run mid-read; every
// run here selects no candidate, so none reads a profile (the processing: signals-process.test.ts).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Context } from "@temporalio/activity";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, loadMasterKeys, newId, newMasterKey } = await import(
  "@whytide/platform"
);
const { filesPort, getAdapter, linkedinPort } = await import("@whytide/providers");
const { ids: creditsIds } = await import("@whytide/credits");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' test hooks by their builds' paths, as the loader imports the modules: the worker
// depends on no module but credits.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").Engager;
type RunResult = { runId: string; status: string; code?: string };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
const log = createLogger({ destination: collectLogs().destination });
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
await startModules(loaded, log);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const files = await getAdapter(filesPort, "fake");
/**
 * A Wednesday and a Thursday at 10:00 UTC, inside the working hours, and a Saturday outside them, all
 * past: a refusal's retryAt, the next quota day or window, is past too, and the run asks again a
 * second later, the shortest wait, until the test moves the clock.
 */
const WEDNESDAY = new Date("2026-10-07T10:00:00.000Z");
const THURSDAY = new Date("2026-10-08T10:00:00.000Z");
const SATURDAY = new Date("2026-10-10T10:00:00.000Z");

/** `count` engagers, the newest an hour ago, a minute apart, members `<from>` on. */
function engagers(count: number, from = 0, newest = Date.now() - 3_600_000): Engager[] {
  return Array.from({ length: count }, (_, n) => ({
    providerMemberRef: `member-${from + n}`,
    profileUrl: `https://www.linkedin.com/in/member-${from + n}`,
    name: `Member ${from + n}`,
    headline: "Head of sales",
    reaction: n % 3 === 0 ? ("comment" as const) : ("like" as const),
    ...(n % 3 === 0 ? { commentText: "Useful, thanks" } : {}),
    engagedAt: new Date(newest - n * 60_000),
  }));
}

/**
 * A workspace with `allowance` credits, a connected account the fake knows, and a source on a post it
 * seeds; and signals' price, as credits' api writes the price list at its start (each test starts
 * truncated).
 */
async function sourceOf(seeded: Engager[], allowance = 100) {
  await asRole("billing_writer").priceListEntry.createMany({
    data: {
      id: newId(creditsIds.price_list_entry),
      action: "signals.engager_read",
      credits: 1,
      unit: "engagers_30",
      version: 1,
      effectiveFrom: new Date(Date.now() - 60_000),
    },
    skipDuplicates: true,
  });
  const [tenant] = await tenancy.createTwoWorkspaces();
  const workspaceId = tenant.workspace.id;
  await grantAllowance([tenant.organization.id], allowance);
  const providerAccountRef = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", providerAccountRef);
  const account = await linkedin.createConnectedAccount(workspaceId, { providerAccountRef });
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}${seeded.length}`;
  fake.seedPost(postUrl, seeded);
  const source = await db().signalSource.create({
    data: {
      id: newId("src"),
      workspaceId,
      kind: "post_engagers",
      config: { postUrl },
      label: "Launch post",
      senderAccountId: account.id,
      createdBy: tenant.user.id,
    },
  });
  return { workspaceId, sourceId: source.id, accountId: account.id, postUrl };
}
type Source = Awaited<ReturnType<typeof sourceOf>>;

type Activity = (input: never) => Promise<unknown>;
const signals_select_candidates = async () => ({ candidateIds: [] });
const run = (source: Source, replaced: Record<string, Activity> = {}) =>
  runWorkflow<RunResult>(
    "signals_run",
    { workspaceId: source.workspaceId, sourceId: source.sourceId },
    { activities: { ...activities, signals_select_candidates, ...replaced } },
  );
/** The staging as the run's last step finds it, before the step empties it. */
function stagingAtEnd() {
  type Staged = {
    providerMemberRef: string;
    reaction: string;
    commentText: string | null;
    rawRef: string;
  };
  const seen = { rows: [] as Staged[] };
  const signals_run_end = async (input: { runId: string }) => {
    seen.rows = await db().signalCandidate.findMany({ where: { runId: input.runId } });
    return activities.signals_run_end?.(input as never);
  };
  return { seen, replaced: { signals_run_end } };
}
/** The run cancelled during the `nth` call of activity `name`, which then runs to its end. */
function cancelledOn(name: string, nth: number): Record<string, Activity> {
  let calls = 0;
  const real = activities[name] as Activity;
  const cancelling = async (input: never) => {
    calls += 1;
    if (calls === nth) {
      const workflowId = Context.current().info.workflowExecution?.workflowId;
      assert.ok(workflowId !== undefined);
      await env.client.workflow.getHandle(workflowId).cancel();
    }
    return real(input);
  };
  return { [name]: cancelling };
}
const cancelled = { message: "Workflow execution cancelled" };
/** The run's row, its candidates, its raw files, its read reservations and its credits. */
async function stateOf(source: Source, runId: string) {
  const row = await db().signalRun.findUniqueOrThrow({ where: { id: runId } });
  const candidates = await db().signalCandidate.findMany({ where: { runId } });
  const prefix = `raw/signals/${runId}/`;
  const raw = await files.list({ workspaceId: source.workspaceId, prefix });
  const reads = await db().senderQuotaReservation.findMany({
    where: { senderAccountId: source.accountId },
    orderBy: { id: "asc" },
  });
  const credits = await db().creditUsage.findMany({
    where: { subjectRef: runId },
    orderBy: { id: "asc" },
  });
  return {
    row,
    candidates,
    raw: raw.files.map(({ key }) => key.slice(`w/${source.workspaceId}/${prefix}`.length)),
    reads: reads.map(({ count, committed, status }) => [count, committed, status]),
    credits: credits.map((usage) => [
      usage.idempotencyKey.replace(runId, "<run>"),
      usage.quantity.toFixed(),
      usage.credits.toFixed(),
      usage.status,
    ]),
  };
}
/** What `read` answers once it answers something, within thirty seconds. */
async function until<T>(read: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== null && value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

test("95 engagers over four pages: four reads and four credits reserved and committed, 95 staged and the staging emptied at the end, four raw files deleted at the end, the watermark moved, done with the counts; a second run with five new ones reads one page and stages them and the one at the watermark, after the vendor's rate limit", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const first = engagers(95);
  const source = await sourceOf(first);
  const staging = stagingAtEnd();
  const one = await run(source, staging.replaced);
  assert.equal(one.status, "done");
  const before = await stateOf(source, one.runId);
  assert.deepEqual(before.row.counts, { pages: 4, read: 95, staged: 95, created: 0 });
  assert.deepEqual(
    [before.row.error, before.row.startedAt !== null, before.row.finishedAt !== null],
    [null, true, true],
  );
  assert.deepEqual(before.raw, []);
  assert.deepEqual(before.reads, Array(4).fill([1, 1, "committed"]));
  assert.deepEqual(before.credits, [["sigrun:<run>", "4", "4", "committed"]]);
  assert.deepEqual(before.candidates, []);
  const staged = staging.seen.rows.map((c) => c.providerMemberRef).sort();
  assert.deepEqual(staged, first.map((e) => e.providerMemberRef).sort());
  const comment = staging.seen.rows.find((c) => c.providerMemberRef === "member-0");
  assert.deepEqual(
    [comment?.reaction, comment?.commentText, comment?.rawRef],
    ["comment", "Useful, thanks", `w/${source.workspaceId}/raw/signals/${one.runId}/1.json`],
  );
  const saved = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.deepEqual(saved.watermark, { engagedAt: first[0]?.engagedAt.toISOString() });
  assert.equal(saved.lastRunAt?.getTime(), before.row.startedAt?.getTime());

  const five = engagers(5, 100, Date.now() - 60_000);
  fake.seedPost(source.postUrl, [...five, ...first]);
  fake.failNext(linkedinPort.errors.linkedin_rate_limited, { retryAfterSec: 1 });
  const again = stagingAtEnd();
  const two = await run(source, again.replaced);
  assert.equal(two.status, "done");
  const after = await stateOf(source, two.runId);
  assert.deepEqual(after.row.counts, { pages: 1, read: 25, staged: 6, created: 0 });
  // The newest of the first run engaged at the watermark exactly: the cut keeps it (alpha-p8-030).
  assert.deepEqual(
    again.seen.rows.map((c) => c.providerMemberRef).sort(),
    [...five, first[0]].map((e) => e?.providerMemberRef).sort(),
  );
  assert.deepEqual(after.raw, []);
  assert.deepEqual(after.reads, Array(5).fill([1, 1, "committed"]));
  assert.deepEqual(after.credits, [["sigrun:<run>", "1", "1", "committed"]]);
  const moved = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.deepEqual(moved.watermark, { engagedAt: five[0]?.engagedAt.toISOString() });
  const limited = await db().senderActionLog.count({
    where: {
      senderAccountId: source.accountId,
      kind: "read_engagers",
      outcome: "linkedin_rate_limited",
    },
  });
  assert.equal(limited, 1);
  linkedin.useClock(undefined);
});

test("the cap reached after a page: the run waits, the credits of the page read committed and the rest released, and resumes once the quota day rolls, reserving a block again", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(30));
  await db().senderAccount.update({ where: { id: source.accountId }, data: { dailyReadCap: 1 } });
  const pending = run(source);
  await until(() =>
    db().signalRun.findFirst({ where: { sourceId: source.sourceId, status: "waiting" } }),
  );
  linkedin.useClock(() => THURSDAY);
  const done = await pending;
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.row.counts, { pages: 2, read: 30, staged: 30, created: 0 });
  assert.deepEqual(state.reads, [
    [1, 1, "committed"],
    [1, 1, "committed"],
  ]);
  assert.deepEqual(state.credits, [
    ["sigrun:<run>", "1", "1", "committed"],
    ["sigrun:<run>:2", "4", "4", "released"],
  ]);
  linkedin.useClock(undefined);
});

test("130 engagers, past the estimate's 120: a second block reserved before the fifth page, the first 100 engagers paid on the first, the last 30 on the second; with 4 credits, the second block refused ends the run failed, insufficient_credits, its open read released and its staging emptied", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(130));
  const done = await run(source);
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.row.counts, { pages: 6, read: 130, staged: 130, created: 0 });
  assert.deepEqual(state.credits, [
    ["sigrun:<run>", "4", "4", "committed"],
    ["sigrun:<run>:2", "1", "1", "committed"],
  ]);

  const short = await sourceOf(engagers(130), 4);
  const staging = stagingAtEnd();
  const failed = await run(short, staging.replaced);
  const code = "insufficient_credits";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const refused = await stateOf(short, failed.runId);
  assert.deepEqual([refused.row.status, refused.row.error], ["failed", code]);
  assert.deepEqual(refused.row.counts, { pages: 4, read: 100, staged: 100, created: 0 });
  assert.deepEqual(refused.reads, [...Array(4).fill([1, 1, "committed"]), [1, null, "released"]]);
  assert.deepEqual(refused.credits, [["sigrun:<run>", "4", "4", "committed"]]);
  assert.equal(staging.seen.rows.length, 100);
  assert.deepEqual(refused.candidates, []);
  linkedin.useClock(undefined);
});

test("a run failed after its first page: the credits of the engagers read committed, the rest released, the staging emptied", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(30));
  const signals_stage_page = async (input: never) => {
    const staged = await activities.signals_stage_page?.(input);
    fake.failNext(linkedinPort.errors.linkedin_account_disconnected);
    return staged;
  };
  const staging = stagingAtEnd();
  const failed = await run(source, { signals_stage_page, ...staging.replaced });
  const code = "linkedin_account_disconnected";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual(state.reads, [
    [1, 1, "committed"],
    [1, 1, "committed"],
  ]);
  assert.deepEqual(state.credits, [["sigrun:<run>", "1", "1", "committed"]]);
  assert.equal(staging.seen.rows.length, 25);
  assert.deepEqual(state.candidates, []);
  linkedin.useClock(undefined);
});

test("a cancelled run ends cancelled, its staging emptied and the engagers read paid: cancelled with a read reserved and not made, that read released; cancelled during a read, the read made committed", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(30));
  await assert.rejects(run(source, cancelledOn("signals_reserve_read", 2)), cancelled);
  const reserved = await db().signalRun.findFirstOrThrow({ where: { sourceId: source.sourceId } });
  const one = await stateOf(source, reserved.id);
  assert.deepEqual(
    [one.row.status, one.row.error, one.row.finishedAt !== null],
    ["cancelled", null, true],
  );
  assert.deepEqual(one.reads, [
    [1, 1, "committed"],
    [1, null, "released"],
  ]);
  assert.deepEqual(one.credits, [["sigrun:<run>", "1", "1", "committed"]]);
  assert.deepEqual(one.candidates, []);

  const other = await sourceOf(engagers(30));
  await assert.rejects(run(other, cancelledOn("linkedin_read_post_engagers", 1)), cancelled);
  const reading = await db().signalRun.findFirstOrThrow({ where: { sourceId: other.sourceId } });
  const two = await stateOf(other, reading.id);
  assert.equal(two.row.status, "cancelled");
  assert.deepEqual(two.reads, [[1, 1, "committed"]]);
  assert.deepEqual(two.credits, [["sigrun:<run>", "1", "1", "committed"]]);
  linkedin.useClock(undefined);
});

test("outside the working hours the run waits for the window; a disconnected account ends it failed, linkedin_account_disconnected, and publishes signals.source_blocked", async () => {
  linkedin.useClock(() => SATURDAY);
  const source = await sourceOf(engagers(3));
  const pending = run(source);
  const waiting = await until(() =>
    db().signalRun.findFirst({ where: { sourceId: source.sourceId, status: "waiting" } }),
  );
  linkedin.useClock(() => THURSDAY);
  assert.deepEqual(await pending, { runId: waiting.id, status: "done" });
  assert.deepEqual((await stateOf(source, waiting.id)).row.counts, {
    pages: 1,
    read: 3,
    staged: 3,
    created: 0,
  });

  await db().senderAccount.update({
    where: { id: source.accountId },
    data: { status: "disconnected" },
  });
  const failed = await run(source);
  const code = "linkedin_account_disconnected";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const row = await db().signalRun.findUniqueOrThrow({ where: { id: failed.runId } });
  assert.deepEqual([row.status, row.error, row.counts], ["failed", code, {}]);
  const blocked = await db().outboxEntry.findMany({
    where: { workspaceId: source.workspaceId, eventName: "signals.source_blocked" },
  });
  assert.deepEqual(
    blocked.map((entry) => entry.payload),
    [{ source_id: source.sourceId, run_id: failed.runId }],
  );
  linkedin.useClock(undefined);
});

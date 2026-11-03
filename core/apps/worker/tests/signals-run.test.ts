// signals' run end to end (alpha-p8-020, alpha-p8-030, beta-p1-090; core/modules/signals/README.md
// "Runs"), on the slice's Temporal and a schema of its database: signals, linkedin and credits loaded
// from their builds by the worker's own loader, their activities through the host's wrapper, on the
// LinkedIn fake and the files fake, set here before the providers load. linkedin's clock (useClock)
// sets the time the read quota reads: a working day at 10:00 UTC, the account's zone. There is no
// time skipping on this Temporal (README "Testing"): a run refused for the cap or the hours waits on
// a timer until the refusal's retryAt, a second at least, and the test moves the quota's clock to the
// next day or into the window while it waits, so the next reservation, the day rolled, is granted. A
// test replaces an activity to see the staging before the last step empties it, to cancel the run
// mid-read, or to stop the workspace's LinkedIn actions after a page (beta-p1-040). The pages cost nothing: `run` selects no candidate, so it reads no profile (the
// processing: signals-process.test.ts); `readAll` reads a profile per candidate, each paid with a
// credit of signals.engager at the price list the api's start writes (writePrices).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ApplicationFailure, Context } from "@temporalio/activity";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, loadMasterKeys, newId, newMasterKey } = await import(
  "@whytide/platform"
);
const { filesPort, getAdapter, linkedinPort } = await import("@whytide/providers");
const { grantAllowance, useCreditsClient } = await import("@whytide/credits/testing");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules, startModules } = await import("../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");

// The modules' test hooks and credits' price list by their builds' paths, as the loader imports the
// modules: the worker depends on no module but credits.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type ContactsTesting = typeof import("../../../modules/contacts/dist/testing/index.js");
type CreditsPrices = typeof import("../../../modules/credits/dist/domain/prices.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const contacts: ContactsTesting = await built("contacts/dist/testing/index.js");
const { assemblePrices, syncPrices }: CreditsPrices = await built("credits/dist/domain/prices.js");
const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
const signalsPrices = new URL("../../../modules/signals/dist/prices.js", import.meta.url).href;
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type Engager = import("@whytide/providers").Engager;
type RunResult = { runId: string; status: string; code?: string };

withTestDb();
const env = withTestWorkflowEnvironment();
const db = () => asRole("app");
useCreditsClient(db());
linkedin.useLinkedinClient(db());
tenancy.useTenancyClient(db());
contacts.useHashSalt("test-salt-".repeat(4));
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

/** The engagers with their profiles seeded in the fake, those `gone` names (from 0) left out. */
function withProfiles(seeded: Engager[], gone: readonly number[] = []): Engager[] {
  for (const [n, { providerMemberRef, profileUrl, name, headline }] of seeded.entries()) {
    if (gone.includes(n)) continue;
    const [firstName = "", lastName = ""] = name.split(" ");
    const title = "Head of Sales";
    const profile = { providerMemberRef, profileUrl, firstName, lastName, headline, title };
    fake.seedProfile({ ...profile, companyName: "Blue Harbor Labs", locationText: "Berlin" });
  }
  return seeded;
}

/**
 * The price list as the api's start writes it (credits' onStart), the next version when it changed:
 * the prices signals declares in a process whose environment has `env` too, so that its engager's is
 * SIGNALS_CREDITS_PER_ENGAGER's value there, with the PRICE_ overrides of `env`.
 */
async function writePrices(env: Record<string, string> = {}) {
  const script = [
    'const { registeredPrices } = await import("@whytide/platform");',
    `await import(${JSON.stringify(signalsPrices)});`,
    "process.stdout.write(JSON.stringify([...registeredPrices().values()]));",
  ].join("\n");
  const declared = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", ...env },
    encoding: "utf8",
  });
  assert.equal(declared.status, 0, declared.stderr);
  await syncPrices(asRole("billing_writer"), assemblePrices(JSON.parse(declared.stdout), env), log);
}

/**
 * A workspace with `allowance` credits, a connected account the fake knows, and a source on a post it
 * seeds; and the price list (each test starts truncated), as `writePrices` writes it with `env`.
 */
async function sourceOf(seeded: Engager[], allowance = 100, prices: Record<string, string> = {}) {
  await writePrices(prices);
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
const runOf = (source: Source, replaced: Record<string, Activity>) =>
  runWorkflow<RunResult>(
    "signals_run",
    { workspaceId: source.workspaceId, sourceId: source.sourceId },
    { activities: { ...activities, ...replaced } },
  );
/** A run of the pages alone: no candidate selected, no profile read. */
const run = (source: Source, replaced: Record<string, Activity> = {}) =>
  runOf(source, { signals_select_candidates, ...replaced });
/** A run that reads a profile per candidate the cheap drops leave. */
const readAll = (source: Source, replaced: Record<string, Activity> = {}) =>
  runOf(source, replaced);
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
/**
 * The run's credits, oldest first: a block's (its subject the run) and its candidates' (keyed
 * `sigprof:<runId>:<candidateId>:<n>`, their subject the candidate).
 */
const usageOf = (runId: string) =>
  db().creditUsage.findMany({
    where: { OR: [{ subjectRef: runId }, { idempotencyKey: { startsWith: `sigprof:${runId}:` } }] },
    orderBy: { id: "asc" },
  });
/** The run's credits, each `[action, key, quantity, credits, status]`, its ids as `<run>`, `<cand>`. */
async function chargesOf(runId: string) {
  return (await usageOf(runId)).map((usage) => [
    usage.action,
    usage.idempotencyKey.replace(runId, "<run>").replace(usage.subjectRef, "<cand>"),
    usage.quantity.toFixed(),
    usage.credits.toFixed(),
    usage.status,
  ]);
}
/** The credits the run committed, summed by action. */
async function committedOf(runId: string) {
  const sums: Record<string, number> = {};
  for (const { action, credits, status } of await usageOf(runId)) {
    if (status === "committed") sums[action] = (sums[action] ?? 0) + Number(credits);
  }
  return sums;
}
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
  return {
    row,
    candidates,
    raw: raw.files.map(({ key }) => key.slice(`w/${source.workspaceId}/${prefix}`.length)),
    reads: reads.map(({ count, committed, status }) => [count, committed, status]),
    credits: await chargesOf(runId),
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

test("95 engagers over four pages: four reads and no credit, 95 staged and the staging emptied at the end, four raw files deleted at the end, the watermark moved, done with the counts; a second run with five new ones reads one page and stages them and the one at the watermark, after the vendor's rate limit", async () => {
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
  assert.deepEqual(before.credits, []);
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
  assert.deepEqual(after.credits, []);
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

test("the cap reached after a page: the run waits, no credit held, and resumes once the quota day rolls", async () => {
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
  assert.deepEqual(state.credits, []);
  linkedin.useClock(undefined);
});

test("130 engagers over six pages cost nothing: with no credit at all, the run reads them all and ends done, nothing reserved", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(130), 0);
  const done = await run(source);
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.row.counts, { pages: 6, read: 130, staged: 130, created: 0 });
  assert.deepEqual(state.reads, Array(6).fill([1, 1, "committed"]));
  assert.deepEqual(state.credits, []);
  linkedin.useClock(undefined);
});

test("a run failed after its first page: no credit, the staging emptied", async () => {
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
  assert.deepEqual(state.credits, []);
  assert.equal(staging.seen.rows.length, 25);
  assert.deepEqual(state.candidates, []);
  linkedin.useClock(undefined);
});

test("a workspace stop ends a running run failed, workspace_stopped, at its next read: the page read committed, no credit, the staging emptied, and no signals.source_blocked", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(30));
  // The tester's "Stop everything" once the first page is staged: the second page's read is refused.
  const signals_stage_page = async (input: never) => {
    const staged = await activities.signals_stage_page?.(input);
    await linkedin.setWorkspaceStopped(source.workspaceId, "tester");
    return staged;
  };
  const staging = stagingAtEnd();
  const stopped = await run(source, { signals_stage_page, ...staging.replaced });
  const code = "workspace_stopped";
  assert.deepEqual(stopped, { runId: stopped.runId, status: "failed", code });
  const state = await stateOf(source, stopped.runId);
  assert.deepEqual([state.row.status, state.row.error], ["failed", code]);
  assert.deepEqual(state.reads, [[1, 1, "committed"]]);
  assert.deepEqual(state.credits, []);
  assert.equal(staging.seen.rows.length, 25);
  assert.deepEqual(state.candidates, []);
  const blocked = await db().outboxEntry.findMany({
    where: { workspaceId: source.workspaceId, eventName: "signals.source_blocked" },
  });
  assert.deepEqual(blocked, []);
  linkedin.useClock(undefined);
});

test("an account its health paused (beta-p6-010: restricted, its cool-down ahead) ends the run failed, account_paused, before any read: nothing read, no credit, and no signals.source_blocked", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(engagers(3));
  const pausedUntil = new Date(WEDNESDAY.getTime() + 72 * 3_600_000);
  await linkedin.setHealth(source.accountId, "restricted", { pausedUntil });
  const calls = fake.recordedCalls.length;
  const failed = await run(source);
  const code = "account_paused";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual([state.row.status, state.row.error], ["failed", code]);
  assert.deepEqual([state.reads, state.credits, fake.recordedCalls.slice(calls)], [[], [], []]);
  const blocked = await db().outboxEntry.findMany({
    where: { workspaceId: source.workspaceId, eventName: "signals.source_blocked" },
  });
  assert.deepEqual(blocked, []);
  linkedin.useClock(undefined);
});

test("a cancelled run ends cancelled, its staging emptied: cancelled with a read reserved and not made, that read released; cancelled during a read, the read made committed; no credit either way", async () => {
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
  assert.deepEqual(one.credits, []);
  assert.deepEqual(one.candidates, []);

  const other = await sourceOf(engagers(30));
  await assert.rejects(run(other, cancelledOn("linkedin_read_post_engagers", 1)), cancelled);
  const reading = await db().signalRun.findFirstOrThrow({ where: { sourceId: other.sourceId } });
  const two = await stateOf(other, reading.id);
  assert.equal(two.row.status, "cancelled");
  assert.deepEqual(two.reads, [[1, 1, "committed"]]);
  assert.deepEqual(two.credits, []);
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

test("30 profiles read commit 30 credits of signals.engager, one per candidate on its own key with the candidate as subject, whose event carries its ULID, and none of signals.engager_read; with SIGNALS_CREDITS_PER_ENGAGER=2 the same run commits 60; with PRICE_SIGNALS_ENGAGER=3 set too, 90", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const charged = async (prices: Record<string, string> = {}) => {
    const source = await sourceOf(withProfiles(engagers(30)), 100, prices);
    const done = await readAll(source);
    assert.equal(done.status, "done");
    const state = await stateOf(source, done.runId);
    assert.deepEqual(state.reads, Array(32).fill([1, 1, "committed"]));
    const usage = await usageOf(done.runId);
    const events = await db().signalEvent.findMany({ where: { runId: done.runId } });
    assert.deepEqual(
      events.map(({ id }) => id).sort(),
      usage.map(({ subjectRef }) => subjectRef.replace(/^cand_/, "sev_")).sort(),
    );
    return { credits: state.credits, committed: await committedOf(done.runId) };
  };
  const credit = (credits: string) => ["signals.engager", "sigprof:<run>:<cand>:1", "1", credits];
  const byDefault = await charged();
  assert.deepEqual(byDefault.credits, Array(30).fill([...credit("1"), "committed"]));
  assert.deepEqual(byDefault.committed, { "signals.engager": 30 });
  const set = { SIGNALS_CREDITS_PER_ENGAGER: "2" };
  assert.deepEqual((await charged(set)).committed, { "signals.engager": 60 });
  const overridden = await charged({ ...set, PRICE_SIGNALS_ENGAGER: "3" });
  assert.deepEqual(overridden.credits, Array(30).fill([...credit("3"), "committed"]));
  assert.deepEqual(overridden.committed, { "signals.engager": 90 });
  linkedin.useClock(undefined);
});

test("a refused read releases its credit: a profile gone is dropped_unread, its credit released, the others' committed; a read whose activity fails releases its credit and its read, and the run fails with the code; a candidate read again in the run reserves under `:2`", async () => {
  linkedin.useClock(() => WEDNESDAY);
  // Members of their own: the fake keeps the profiles the tests before seeded.
  const source = await sourceOf(withProfiles(engagers(3, 1000), [1]));
  const done = await readAll(source);
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  assert.deepEqual(state.row.counts, {
    ...{ pages: 1, read: 3, staged: 3, created: 2, profiles_read: 2, dropped_unread: 1 },
  });
  const credit = ["signals.engager", "sigprof:<run>:<cand>:1", "1", "1"];
  assert.deepEqual(state.credits, [
    [...credit, "committed"],
    [...credit, "released"],
    [...credit, "committed"],
  ]);
  assert.deepEqual(state.reads, Array(4).fill([1, 1, "committed"]));

  const other = await sourceOf(withProfiles(engagers(2, 2000)));
  let reads = 0;
  const linkedin_read_profile = async (input: never) => {
    reads += 1;
    if (reads === 1) return activities.linkedin_read_profile?.(input);
    throw ApplicationFailure.create({ type: "linkedin_error_unmapped", nonRetryable: true });
  };
  const failed = await readAll(other, { linkedin_read_profile });
  const code = "linkedin_error_unmapped";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const after = await stateOf(other, failed.runId);
  assert.deepEqual(after.credits, [
    [...credit, "committed"],
    [...credit, "released"],
  ]);
  assert.deepEqual(after.reads, [
    [1, 1, "committed"],
    [1, 1, "committed"],
    [1, null, "released"],
  ]);

  // The one candidate selected twice: its first credit released, the second is a key of its own.
  const twice = await sourceOf(withProfiles(engagers(1, 3000), [0]));
  const signals_select_candidates = async (input: never) => {
    const selected = await activities.signals_select_candidates?.(input);
    const { candidateIds } = selected as { candidateIds: string[] };
    return { candidateIds: [...candidateIds, ...candidateIds] };
  };
  const again = await readAll(twice, { signals_select_candidates });
  assert.equal(again.status, "done");
  const released = (n: number) => [
    "signals.engager",
    `sigprof:<run>:<cand>:${n}`,
    "1",
    "1",
    "released",
  ];
  assert.deepEqual((await stateOf(twice, again.runId)).credits, [released(1), released(2)]);
  linkedin.useClock(undefined);
});

test("a retried reserve or settle step charges once: each candidate one row, committed once", async () => {
  linkedin.useClock(() => WEDNESDAY);
  const source = await sourceOf(withProfiles(engagers(3)));
  /** The step run twice, as Temporal retries one whose first answer was lost. */
  const twice = (name: string) => async (input: never) => {
    await activities[name]?.(input);
    return activities[name]?.(input);
  };
  const done = await readAll(source, {
    signals_reserve_engager_credit: twice("signals_reserve_engager_credit"),
    signals_settle_engager_credit: twice("signals_settle_engager_credit"),
  });
  assert.equal(done.status, "done");
  const state = await stateOf(source, done.runId);
  const credit = ["signals.engager", "sigprof:<run>:<cand>:1", "1", "1", "committed"];
  assert.deepEqual(state.credits, Array(3).fill(credit));
  assert.deepEqual(await committedOf(done.runId), { "signals.engager": 3 });
  linkedin.useClock(undefined);
});

test("an empty balance ends the run failed, insufficient_credits: a released credit back in the balance, the candidate refused its credit has its read released, the profiles read before it processed, the watermark kept", async () => {
  linkedin.useClock(() => WEDNESDAY);
  // Two credits: the first profile's, the second's released as it is gone, the third's; none left
  // for the fourth. The history signals_run_engager_price.json is this run's.
  const source = await sourceOf(withProfiles(engagers(4, 4000), [1]), 2);
  const failed = await readAll(source);
  const code = "insufficient_credits";
  assert.deepEqual(failed, { runId: failed.runId, status: "failed", code });
  const state = await stateOf(source, failed.runId);
  assert.deepEqual([state.row.status, state.row.error], ["failed", code]);
  assert.deepEqual(state.row.counts, {
    ...{ pages: 1, read: 4, staged: 4, created: 2, profiles_read: 2, dropped_unread: 1 },
  });
  assert.deepEqual(state.reads, [...Array(4).fill([1, 1, "committed"]), [1, null, "released"]]);
  const credit = ["signals.engager", "sigprof:<run>:<cand>:1", "1", "1"];
  assert.deepEqual(state.credits, [
    [...credit, "committed"],
    [...credit, "released"],
    [...credit, "committed"],
  ]);
  assert.deepEqual([state.candidates, state.raw], [[], []]);
  const leads = await db().lead.count({ where: { workspaceId: source.workspaceId } });
  assert.equal(leads, 2);
  const kept = await db().signalSource.findUniqueOrThrow({ where: { id: source.sourceId } });
  assert.equal(kept.watermark, null);
  linkedin.useClock(undefined);
});

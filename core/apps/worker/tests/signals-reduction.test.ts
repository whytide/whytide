// signals' evidence reduction end to end (alpha-p10-020; core/modules/signals/README.md "Reduction"),
// on the slice's Temporal and a schema of its database: signals loaded from its build by the worker's
// own loader, its activities through the host's wrapper; the daily tick's schedule as the host
// upserts it; the tick, whose starts reach a starter bound here; each workspace's reduction; and
// `pnpm evidence:reduce`. The harness has no time skipping (README "Testing"), so the evidence is
// captured 31 and 29 days before the reduction runs. The reduced rows are those alpha-p8-050's
// panel spec seeds: URL, author, reaction and captured_at kept, excerpt and comment null, reduced_at.
import assert from "node:assert/strict";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  bindWorkflowStarter,
  collectLogs,
  createLogger,
  type WorkflowStart,
} from "@whytide/platform";
import { hostActivity } from "../src/activities.ts";
import { moduleLoaders } from "../src/modules.generated.ts";
import { loadModules } from "../src/modules.ts";
import { runWorkflow, withTestWorkflowEnvironment } from "../testing/index.ts";

// signals' and tenancy's code and test helpers by their builds' paths, the files the worker's loader
// imports: the worker depends on neither module.
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
type Cli = typeof import("../../../modules/signals/dist/cli/reduce-evidence.js");
type Reduce = typeof import("../../../modules/signals/dist/domain/reduce/reduce.js");
type SignalsTesting = typeof import("../../../modules/signals/dist/testing/index.js");
type TenancyTesting = typeof import("../../../modules/tenancy/dist/testing/index.js");
const { runReduceEvidence }: Cli = await built("signals/dist/cli/reduce-evidence.js");
const { reductionStart }: Reduce = await built("signals/dist/domain/reduce/reduce.js");
const { createSignalEvent }: SignalsTesting = await built("signals/dist/testing/index.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");

withTestDb();
withTestWorkflowEnvironment();
const db = () => asRole("app");
tenancy.useTenancyClient(db());
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "signals"));
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: db(), log })];
  }),
);
const DAY_MS = 86_400_000;
const WORDS = "Exactly our problem.";
/** The post and the author signals' factory writes. */
const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000009";
const AUTHOR = "Test Engager";

/** `count` comments in the workspace, each with its event and evidence, captured `days` ago. */
async function captured(workspaceId: string, count: number, days: number): Promise<Date> {
  const occurredAt = new Date(Date.now() - days * DAY_MS);
  for (let n = 0; n < count; n += 1) {
    const personId = `per_${days}_${n}`;
    await createSignalEvent({ workspaceId, personId, occurredAt, commentText: WORDS });
  }
  return occurredAt;
}
/** The workspace's evidence, oldest captured first; each keeps its post, author and reaction. */
async function evidenceOf(workspaceId: string) {
  const orderBy = [{ capturedAt: "asc" }, { id: "asc" }] as const;
  const rows = await db().evidence.findMany({ where: { workspaceId }, orderBy: [...orderBy] });
  for (const row of rows)
    assert.deepEqual([row.url, row.author, row.reaction], [POST, AUTHOR, "comment"]);
  return rows.map((row) => ({
    capturedAt: row.capturedAt.toISOString(),
    excerpt: row.excerpt,
    commentText: row.commentText,
    reduced: row.reducedAt !== null,
  }));
}
const reduced = (at: Date) => ({
  capturedAt: at.toISOString(),
  excerpt: null,
  commentText: null,
  reduced: true,
});
const kept = (at: Date) => ({
  capturedAt: at.toISOString(),
  excerpt: WORDS,
  commentText: WORDS,
  reduced: false,
});
const reduce = (start: WorkflowStart) => runWorkflow(start.workflow, start.input, { activities });

test("the daily tick starts every workspace's signals_evidence_reduction, one at a time by signals.evidence_reduction:<workspace>:current; each reduces its own evidence captured 31 days ago, a batch of 500 at a time, keeping URL, author, reaction and captured_at, dropping excerpt and comment, setting reduced_at, and leaves the evidence of 29 days ago untouched", async () => {
  const schedule = loaded.schedules.find(({ id }) => id === "signals.evidence_reduction");
  assert.deepEqual(schedule, {
    id: "signals.evidence_reduction",
    workflow: "signals_evidence_reduction_tick",
    spec: { cronExpressions: ["0 3 * * *"], timezone: "UTC" },
    input: {},
  });
  const [a, b] = await tenancy.createTwoWorkspaces();
  const [one, two] = [a.workspace.id, b.workspace.id];
  const old = await captured(one, 501, 31);
  const recent = await captured(one, 1, 29);
  const other = await captured(two, 1, 31);

  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  try {
    const counts = await runWorkflow("signals_evidence_reduction_tick", {}, { activities });
    assert.deepEqual(counts, { workspaces: 2, started: 2 });
  } finally {
    unbind();
  }
  assert.deepEqual(starts, [one, two].sort().map(reductionStart));

  assert.deepEqual(await reduce(reductionStart(one)), { reduced: 501 });
  assert.deepEqual(await evidenceOf(one), [...Array(501).fill(reduced(old)), kept(recent)]);
  assert.deepEqual(await evidenceOf(two), [kept(other)]);
  assert.deepEqual(await reduce(reductionStart(two)), { reduced: 1 });
  assert.deepEqual(await evidenceOf(two), [reduced(other)]);
  assert.deepEqual(await reduce(reductionStart(one)), { reduced: 0 });
});

test("pnpm evidence:reduce --workspace <slug> reduces the rows the workflow reduces and prints the count; another workspace's stay", async () => {
  const [a, b] = await tenancy.createTwoWorkspaces();
  const old = await captured(a.workspace.id, 1, 31);
  const recent = await captured(a.workspace.id, 1, 29);
  const other = await captured(b.workspace.id, 1, 31);
  const lines: string[] = [];
  const print = (line: string) => lines.push(line);
  assert.equal(await runReduceEvidence(["--workspace", a.workspace.slug], print, db()), 0);
  assert.equal(await runReduceEvidence([], print, db()), 2);
  assert.deepEqual(lines, [
    `evidence_reduced: 1 in ${a.workspace.id}`,
    "usage: pnpm evidence:reduce --workspace <id or slug>",
  ]);
  assert.deepEqual(await evidenceOf(a.workspace.id), [reduced(old), kept(recent)]);
  assert.deepEqual(await evidenceOf(b.workspace.id), [kept(other)]);
});

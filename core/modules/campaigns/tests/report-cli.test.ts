// `pnpm campaigns:report` end to end (beta-p7-020; README.md "Commands"): runReport against the
// worktree's database, in a schema of its own (withTestDb), its clock a month after the sends, so
// that every invite is old enough for the acceptance rate. Two workspaces tenancy made, each with the
// approver's account, its reference sealed, and a clean connection request: the lines in order and
// exit 0; a planted violation of each zero, each listed, exit 1; --workspace by slug or id; --since;
// workspace_not_found; the usage; and the built file run by node alone. No line holds a name, a
// text, a profile or a provider reference.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { createApprovalItem } from "@whytide/approvals/testing";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { ids as linkedinIds } from "@whytide/linkedin";
import {
  createConnectedAccount,
  useLinkedinClient,
  useSecretKeys,
} from "@whytide/linkedin/testing";
import { loadMasterKeys, newId, newMasterKey } from "@whytide/platform";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { SENDER_SPAN_DAYS, USAGE } from "../cli/constants.ts";
import { runReport } from "../cli/report.ts";
import { useClock } from "../domain/clock.ts";
import { utcDay } from "../domain/report/days.ts";
import { weekdaysBefore } from "../domain/report/decisions.ts";
import { ids } from "../ids.ts";
import { APPROVER } from "./fixtures.ts";
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  type ReportFixture,
  reportFixture,
  TEXT,
} from "./report-fixtures.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useLinkedinClient(app);
useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
useHashSalt("test-salt-".repeat(4));
const MODULE = join(import.meta.dirname, "..");
/** The run's instant: a month after the sends, which the approvals date now. */
const NOW = new Date(Date.now() + 30 * DAY_MS);
/** The planted violations' instant: after the approvals, 20 days before the run. */
const OLD = new Date(NOW.getTime() - 20 * DAY_MS);
/** The accounts' sealed references, which no line may hold. */
const REFERENCE = "fake-account-report-cli";
/** The persons' profiles are linkedin.com/in/<SLUG>-<n>; the drafts' text names Noor. */
const SLUG = "report-cli";

/** A workspace as the tests seed it: its fixture, its account and its clean connection request. */
type Seeded = {
  readonly tenant: TestTenant;
  readonly fx: ReportFixture;
  readonly accountId: string;
  readonly clean: { readonly step: string; readonly rowId: string; readonly at: Date };
};
let leads = 0;

/** The two workspaces in the order the command reads them, by id (the file's header). */
async function seeded(): Promise<[Seeded, Seeded]> {
  const tenants = [...(await createTwoWorkspaces())].sort((x, y) =>
    x.workspace.id < y.workspace.id ? -1 : 1,
  );
  const made: Seeded[] = [];
  for (const [n, tenant] of tenants.entries()) {
    const fx = reportFixture(tenant.workspace.id);
    const owner = { ownerUserId: APPROVER, providerAccountRef: `${REFERENCE}-${n}` };
    const { id: accountId } = await createConnectedAccount(tenant.workspace.id, owner);
    const step = await stepOf(fx);
    made.push({ tenant, fx, accountId, clean: { step, ...(await fx.approvedSend(step)) } });
  }
  const [first, second] = made;
  if (first === undefined || second === undefined) throw new Error("seeded: two workspaces");
  return [first, second];
}
/** A new lead's connection request, `message_1` when asked. */
async function stepOf(fx: ReportFixture, key: "connect" | "message_1" = "connect") {
  return (await fx.enrolledLead(`${SLUG}-${++leads}`)).steps[key];
}

/** The command at NOW: its exit code and its lines. */
async function report(...args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  useClock(() => NOW);
  try {
    const code = await runReport(args, (line) => lines.push(line), { client: app });
    return { code, lines };
  } finally {
    useClock(undefined);
  }
}
/** linkedin's health event into `toState`, as applyHealth records one: its id. */
async function healthEvent(
  seed: Seeded,
  event: {
    toState: "restricted" | "checkpoint";
    trigger: "limit_reached" | "checkpoint";
    at: Date;
  },
): Promise<string> {
  const id = newId(linkedinIds.sender_health_event);
  const { toState, trigger, at: createdAt } = event;
  await app.senderHealthEvent.create({
    data: {
      ...{ id, workspaceId: seed.tenant.workspace.id, senderId: seed.accountId },
      ...{ fromState: "healthy", toState, trigger, metrics: {}, createdAt },
    },
  });
  return id;
}
/** No line holds a name, the text, a profile, the account's label or its reference. */
function holdsNothingPersonal(lines: readonly string[]) {
  const output = lines.join("\n");
  for (const kept of [TEXT, "Noor", SLUG, "linkedin.com", "LinkedIn", REFERENCE]) {
    assert.ok(!output.includes(kept), `the output holds ${kept}`);
  }
}

test("clean data: every figure's line in order, the three zeros and exit 0, and nothing personal", async () => {
  const [a, b] = await seeded();
  const [wa, wb] = [a.tenant.workspace.id, b.tenant.workspace.id];
  // A: its invite accepted, a second clean invite 21 days later, a message approved unedited, and a
  // decision on the last weekday before the run's day. B: a checkpoint, no decision.
  await a.fx.app().stepExecution.update({
    where: { id: a.clean.step },
    data: { acceptedAt: new Date(a.clean.at.getTime() + HOUR_MS) },
  });
  const later = new Date(a.clean.at.getTime() + SENDER_SPAN_DAYS * DAY_MS);
  await a.fx.approvedSend(await stepOf(a.fx), { at: later });
  const message = await stepOf(a.fx, "message_1");
  await a.fx.dueAt(message, new Date());
  assert.equal(await a.fx.queue(message), "opened");
  await a.fx.draftReady(message, TEXT);
  await a.fx.approveItem(message);
  const [lastWeekday] = weekdaysBefore(utcDay(NOW), 7);
  await createApprovalItem({
    ...{
      workspaceId: wa,
      personId: "per_01JABCDEFGHJKMNPQRSTVWXYZ0",
      senderAccountId: a.accountId,
    },
    ...{ stepExecutionId: newId(ids.step_execution), status: "skipped" },
    decidedAt: new Date(`${lastWeekday}T12:00:00Z`),
  });
  const checkpointAt = new Date(NOW.getTime() - 2 * DAY_MS);
  const checkpoint = await healthEvent(b, {
    ...{ toState: "checkpoint", trigger: "checkpoint" },
    at: checkpointAt,
  });

  const { code, lines } = await report();
  assert.deepEqual(lines, [
    "sends_without_approval: 0",
    "send_step_missing: 0",
    "actions_against_suppressed: 0",
    "duplicate_sends: 0",
    "drafts_small_edits: 1.000 approved=1 unedited=1 small_edits=0 target=0.5",
    "acceptance_rate: 0.333 sent=3 accepted=1 target=0.25",
    `acceptance_rate_sender: ${wa} ${a.accountId} 0.500`,
    `acceptance_rate_sender: ${wb} ${b.accountId} 0.000`,
    "senders_three_weeks: 1 target=3",
    `sender_span: ${wa} ${a.accountId} ${utcDay(a.clean.at)} ${utcDay(later)} 21`,
    `sender_span: ${wb} ${b.accountId} ${utcDay(b.clean.at)} ${utcDay(b.clean.at)} 0`,
    "restrictions: 0",
    "checkpoints: 1",
    `health_event: ${wb} ${b.accountId} ${checkpoint} checkpoint checkpoint ${checkpointAt.toISOString()}`,
    `decision_days: ${wa} 1 of 5`,
    `decision_days: ${wb} 0 of 5`,
  ]);
  assert.equal(code, 0);
  holdsNothingPersonal(lines);
});

test("a planted violation of each zero: each listed and exit 1; --workspace by slug or id reads that workspace alone; --since after them reads none", async () => {
  const [a, b] = await seeded();
  const [wa, wb] = [a.tenant.workspace.id, b.tenant.workspace.id];
  // In B: a send never approved, a send to a person opted out an hour before it, and a second row for
  // its clean send; in A, a row naming no step and a restriction, neither of which breaks a zero.
  const bare = await stepOf(b.fx);
  assert.equal(await b.fx.queue(bare), "opened");
  await b.fx.sendStep(bare, { at: OLD });
  const optedOut = await b.fx.enrolledLead(`${SLUG}-${++leads}`);
  await b.fx.approvedSend(optedOut.steps.connect, { at: OLD });
  await b.fx.suppress(optedOut.personId, { createdAt: new Date(OLD.getTime() - HOUR_MS) });
  const again = new Date(OLD.getTime() + 5 * MINUTE_MS);
  const second = await b.fx.logSend({
    accountId: b.accountId,
    stepExecutionId: b.clean.step,
    at: again,
  });
  const noStep = await a.fx.logSend({ accountId: a.accountId, stepExecutionId: null, at: OLD });
  const restrictedAt = new Date(OLD.getTime() + HOUR_MS);
  const restriction = await healthEvent(a, {
    ...{ toState: "restricted", trigger: "limit_reached" },
    at: restrictedAt,
  });

  const violations = [
    "sends_without_approval: 1",
    `violation: sends_without_approval ${wb} ${bare} no_approval ${OLD.toISOString()}`,
    "send_step_missing: 1",
    `missing_step: ${wa} ${noStep} none ${a.accountId} invite ${OLD.toISOString()}`,
    "actions_against_suppressed: 1",
    `violation: actions_against_suppressed ${wb} ${optedOut.steps.connect} opted_out ${OLD.toISOString()}`,
    "duplicate_sends: 1",
    `violation: duplicate_sends ${wb} ${b.clean.step} ${b.clean.rowId},${second}`,
  ];
  const every = await report();
  assert.equal(every.code, 1);
  assert.deepEqual(every.lines.slice(0, violations.length), violations);
  const restricted = `${wa} ${a.accountId} ${restriction} restricted limit_reached`;
  const warnings = ["restrictions: 1", `health_event: ${restricted} ${restrictedAt.toISOString()}`];
  const at = every.lines.indexOf("restrictions: 1");
  assert.deepEqual(every.lines.slice(at, at + 3), [...warnings, "checkpoints: 0"]);
  holdsNothingPersonal(every.lines);

  const ours = await report("--workspace", a.tenant.workspace.slug);
  assert.equal(ours.code, 0, "A holds the three zeros");
  assert.ok(ours.lines.every((line) => !line.includes(wb)));
  assert.deepEqual(ours.lines.slice(0, 2), ["sends_without_approval: 0", "send_step_missing: 1"]);
  const theirs = await report("--workspace", wb);
  assert.equal(theirs.code, 1);
  assert.ok(theirs.lines.every((line) => !line.includes(wa)));
  const theirViolations = violations.filter((line) => !line.includes(wa));
  assert.deepEqual(
    theirs.lines.filter((line) => line.startsWith("violation: ")),
    theirViolations.filter((line) => line.startsWith("violation: ")),
  );

  // From two days after them: no row of the period breaks a zero.
  const since = utcDay(new Date(OLD.getTime() + 2 * DAY_MS));
  const after = await report("--since", since);
  assert.equal(after.code, 0);
  assert.deepEqual(after.lines.slice(0, 4), [
    "sends_without_approval: 0",
    "send_step_missing: 0",
    "actions_against_suppressed: 0",
    "duplicate_sends: 0",
  ]);
});

test("refused: an unknown workspace id or slug prints workspace_not_found and exits 1; an unknown argument, a positional, a value missing or a malformed day prints the usage and exits 2", async () => {
  await seeded();
  for (const named of ["wsp_missing", "no-such-slug", "Not a slug"]) {
    assert.deepEqual(await report("--workspace", named), {
      code: 1,
      lines: [`workspace_not_found: ${named}`],
    });
  }
  const usage = [
    ["--bogus"],
    ["extra"],
    ["--workspace"],
    ["--since"],
    ["--since", "2026-13-01"],
    ["--since", "2026-02-30"],
    ["--since", "20261001"],
    ["--since", "2026-10-01T00:00:00Z"],
  ];
  for (const args of usage) {
    assert.deepEqual(await report(...args), { code: 2, lines: [USAGE] }, args.join(" "));
  }
});

test("the built dist/cli/report.js runs with node alone: an unknown argument prints the usage and exits 2", () => {
  const child = spawnSync(process.execPath, ["dist/cli/report.js", "--bogus"], {
    cwd: MODULE,
    encoding: "utf8",
  });
  assert.equal(child.status, 2, child.stderr);
  assert.equal(child.stdout, `${USAGE}\n`);
});

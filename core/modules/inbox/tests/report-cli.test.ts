// `pnpm inbox:report` end to end (gamma-p7-060; README.md "The report"): the command's function
// against the worktree's database, in a schema of its own (withTestDb), on rows in end states and a
// fixed --since. Every workspace, or the one named by slug or id; the lines, ids, weeks, counts and
// shares only, never a text or a name; the refusal and the usage, with their exit codes. Made-up
// names only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import { REPORT_USAGE } from "../cli/constants.ts";
import { runReport } from "../cli/report.ts";
import { reportLines } from "../cli/report-lines.ts";
import { reportFixture } from "./report-fixtures.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useHashSalt("test-salt-".repeat(4));

const SINCE = "2026-10-01";
const day = (monthDay: string) => new Date(`2026-${monthDay}T12:00:00.000Z`);

/** The command: its exit code and lines. */
async function run(...args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runReport(args, (line) => lines.push(line), { client: app });
  return { code, lines };
}

/** Workspace a: two signal-sourced leads touched in 2026-W44, one replying, labeled interested. */
async function seeded() {
  const [a, b] = await createTwoWorkspaces();
  const f = reportFixture(a.workspace.id);
  const [first, second] = [await f.lead("signal"), await f.lead("signal")];
  await f.touch(first, day("10-27"));
  await f.touch(second, day("10-27"), "message");
  await f.reply(first, day("10-28"), {
    owner: { classLabel: "interested" },
    classified: { label: "interested" },
  });
  return { a, b, persons: [first, second] };
}

test("every workspace, then one by slug or id: the reply rate, each active week's positives, their mean and the agreement, too_few under 30 pairs; ids, weeks, counts and shares only", async () => {
  const { a, b, persons } = await seeded();
  const expected = [
    "reply_rate_linkedin: 0.500 touched=2 replied=1 target=0.06",
    `positive_week: ${a.workspace.id} 2026-W44 1`,
    "positive_conversations: 1.000 workspace_weeks=1 positives=1 target=1",
    "classifier_agreement: too_few pairs=1",
  ];
  assert.deepEqual(await run("--since", SINCE), { code: 0, lines: expected });
  assert.deepEqual(await run("--workspace", a.workspace.slug, "--since", SINCE), {
    code: 0,
    lines: expected,
  });
  const theirs = await run("--workspace", b.workspace.id);
  assert.deepEqual(theirs, {
    code: 0,
    lines: [
      "reply_rate_linkedin: none touched=0 replied=0 target=0.06",
      "positive_conversations: none workspace_weeks=0 positives=0 target=1",
      "classifier_agreement: too_few pairs=0",
    ],
  });
  // Without --since, every row: the same here.
  const all = await run();
  assert.deepEqual(all.lines, expected);
  const printed = all.lines.join("\n");
  for (const value of ["Ottoline", "Vashti", "linkedin.com", "Thanks", ...persons]) {
    assert.ok(!printed.includes(value), value);
  }
});

test("the agreement's line on 30 pairs or more: the F1 and the opt-out share with their targets; none where nothing was counted", () => {
  const lines = reportLines({
    replyRateLinkedin: { touched: 0, replied: 0, share: null },
    positive: { weeks: [], mean: null },
    agreement: { pairs: 34, tooFew: false, f1Interested: 0.95, optOutShare: null },
  });
  assert.equal(
    lines.at(-1),
    "classifier_agreement: f1_interested=0.950 opt_out_share=none pairs=34 target_f1=0.93 target_opt_out=0.99",
  );
});

test("refused: an unknown workspace id or slug prints workspace_not_found and exits 1; a usage error prints the usage and exits 2", async () => {
  await seeded();
  for (const named of ["wsp_missing", "no-such-slug", "Not a slug"]) {
    assert.deepEqual(await run("--workspace", named), {
      code: 1,
      lines: [`workspace_not_found: ${named}`],
    });
  }
  for (const args of [
    ["--bogus"],
    ["extra"],
    ["--workspace"],
    ["--since", "2026-02-30"],
    ["--since", "2026-10-1"],
    ["--since", "soon"],
  ]) {
    assert.deepEqual(await run(...args), { code: 2, lines: [REPORT_USAGE] }, args.join(" "));
  }
});

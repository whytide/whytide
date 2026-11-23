// `pnpm inbox:export-labels` end to end (beta-p7-030; README.md "The reply golden set"): the command's
// function against the worktree's database, in a schema of its own (withTestDb), the files port on its
// fake, at a fixed instant, a Wednesday. Two workspaces, their leads made by contacts' commands, their
// threads, messages and labels as the store and the label leave them (testing/): a line per workspace
// and the totals across both, a tester counted once, each file every member's threads, where the
// route's holds the caller's own only (gamma-p6-060); one workspace by slug or id; --week; the
// refusals, which write nothing; the usage. Made-up names only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { test } from "node:test";
import { createLeadForPerson, upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter } from "@whytide/providers";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { USAGE } from "../cli/constants.ts";
import { runExportLabels } from "../cli/export-labels.ts";
import {
  createLabel,
  createMessage,
  createThread,
  useInboxExportClient,
} from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useInboxExportClient(app);
useHashSalt("test-salt-".repeat(4));
const files = await getAdapter(filesPort, filesConfig.PROVIDER_FILES);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The command's now: Wednesday of 2026-W44, so that every label below falls in a known week. */
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const TODAY = "2026-10-28";
const WEEK = "2026-W44";
const LAST_WEEK = "2026-W43";
/** The testers, owners of the sender accounts: T1 owns threads in both workspaces. */
const T1 = "usr_tester_one";
const T2 = "usr_tester_two";
const T3 = "usr_tester_three";
/** A reply sent `sent` before NOW, labeled `labeled` before NOW when it has a label. */
type Reply = {
  readonly sent: number;
  readonly label?: "positive" | "not_positive";
  readonly labeled?: number;
};
type Thread = {
  readonly first: string;
  readonly last: string;
  readonly owner: string;
  readonly replies: readonly Reply[];
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * The tenant's threads, each with its lead, the campaign's first message and the replies; the
 * persons' ids by first name.
 */
async function seed(tenant: TestTenant, threads: readonly Thread[]): Promise<Map<string, string>> {
  const workspaceId = tenant.workspace.id;
  const persons = new Map<string, string>();
  for (const { first, last, owner, replies } of threads) {
    const personId = await withTenant(
      { workspaceId, principal: servicePrincipal("inbox_test") },
      async () => {
        const linkedinUrl = `https://linkedin.com/in/${first.toLowerCase()}-${randomUUID()}`;
        const profile = { linkedinUrl, firstName: first, lastName: last };
        const source = { source: "import", provider: "csv" } as const;
        const { person } = await upsertPersonFromSource({ ...source, profile });
        await createLeadForPerson({
          personId: person.id,
          source: { kind: "imported", ref: "imp_1" },
        });
        return person.id;
      },
      { client: app },
    );
    persons.set(first, personId);
    const oldest = Math.max(...replies.map(({ sent }) => sent)) + HOUR;
    const threadId = await createThread({ workspaceId, personId, ownerUserId: owner });
    const thread = { workspaceId, threadId, personId };
    await createMessage({
      ...{ ...thread, direction: "out", sentBy: "campaign", sentAt: new Date(NOW - oldest) },
      body: `Hi ${first}, a question about your data team.`,
    });
    for (const { sent, label, labeled = 0 } of replies) {
      const body = `Thanks, ${first} ${last} here. Tuesday?`;
      const messageId = await createMessage({ ...thread, body, sentAt: new Date(NOW - sent) });
      if (label === undefined) continue;
      const labeledAt = new Date(NOW - labeled);
      await createLabel({ workspaceId, messageId, label, labeledBy: owner, labeledAt });
    }
  }
  return persons;
}

/**
 * Workspace A: Ottoline's reply positive (T1); Bramwell's two, an old one positive last week and
 * the latest not positive (T2); Saoirse's unlabeled (T1). Workspace B: Linnea's positive (T1),
 * Tamsin's not positive (T3).
 */
async function seeded() {
  const [a, b] = await createTwoWorkspaces();
  const ours = await seed(a, [
    {
      ...{ first: "Ottoline", last: "Vashti", owner: T1 },
      replies: [{ sent: 3 * HOUR, label: "positive", labeled: 2 * MINUTE }],
    },
    {
      ...{ first: "Bramwell", last: "Okonkwo", owner: T2 },
      replies: [
        { sent: 9 * DAY, label: "positive", labeled: 8 * DAY },
        { sent: 2 * HOUR, label: "not_positive", labeled: MINUTE },
      ],
    },
    { first: "Saoirse", last: "Delacroix", owner: T1, replies: [{ sent: 2 * HOUR }] },
  ]);
  const theirs = await seed(b, [
    {
      ...{ first: "Linnea", last: "Haverkamp", owner: T1 },
      replies: [{ sent: 2 * HOUR, label: "positive", labeled: 2 * MINUTE }],
    },
    {
      ...{ first: "Tamsin", last: "Achterberg", owner: T3 },
      replies: [{ sent: 2 * HOUR, label: "not_positive", labeled: MINUTE }],
    },
  ]);
  return { a, b, ours, theirs };
}

/** The command at NOW: its exit code and lines. */
async function run(...args: string[]): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runExportLabels(args, (line) => lines.push(line), new Date(NOW));
  return { code, lines };
}
const keyOf = (tenant: TestTenant, name: string) =>
  `w/${tenant.workspace.id}/exports/reply-labels-${name}.jsonl`;
const written = (key: string, lines: number, positive: number) =>
  `reply_labels_written: ${key}, ${lines} lines, ${positive} positive`;
const total = (labeled: number, positive: number, workspaces: number, testers: number) =>
  `reply_labels_total: ${labeled} labeled, ${positive} positive, ${workspaces} workspaces with a positive reply, ${testers} testers with a positive reply`;
/** The lines of a stored file. */
async function stored(tenant: TestTenant, key: string): Promise<Record<string, unknown>[]> {
  const body = await text((await files.get({ workspaceId: tenant.workspace.id, key })).body);
  return body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
/** The keys under the tenant's exports/. */
async function listed(tenant: TestTenant): Promise<string[]> {
  const { files: listing } = await files.list({
    workspaceId: tenant.workspace.id,
    prefix: "exports/",
  });
  return listing.map(({ key }) => key);
}

test("every workspace: a line each with its file, its lines and its positives, then the totals, a tester counted once across workspaces; each file holds its workspace's replies only, both members' threads", async () => {
  const { a, b, ours, theirs } = await seeded();
  const { code, lines } = await run();
  assert.equal(code, 0);
  const each = [
    { tenant: a, lines: 3, positive: 2 },
    { tenant: b, lines: 2, positive: 1 },
  ].sort((x, y) => (x.tenant.workspace.id < y.tenant.workspace.id ? -1 : 1));
  assert.deepEqual(lines, [
    ...each.map(({ tenant, ...n }) => written(keyOf(tenant, TODAY), n.lines, n.positive)),
    total(5, 3, 2, 2),
  ]);
  const hashed = (persons: Map<string, string>, first: string) => sha256(persons.get(first) ?? "");
  const linesOf = async (tenant: TestTenant) =>
    (await stored(tenant, keyOf(tenant, TODAY))).map((line) => [line.person_sha256, line.label]);
  // T2's Bramwell and T1's Ottoline: the operator's file holds both members' threads.
  assert.deepEqual(await linesOf(a), [
    [hashed(ours, "Bramwell"), "positive"],
    [hashed(ours, "Ottoline"), "positive"],
    [hashed(ours, "Bramwell"), "not_positive"],
  ]);
  assert.deepEqual(await linesOf(b), [
    [hashed(theirs, "Linnea"), "positive"],
    [hashed(theirs, "Tamsin"), "not_positive"],
  ]);
});

test("--workspace by slug or id: that workspace alone and its totals; --week: that ISO week's labels only, to reply-labels-<week>.jsonl, the day's full file left in place; an earlier week", async () => {
  const { a, b } = await seeded();
  const full = await run("--workspace", a.workspace.slug);
  assert.deepEqual(full, { code: 0, lines: [written(keyOf(a, TODAY), 3, 2), total(3, 2, 1, 2)] });
  const dayFile = await stored(a, keyOf(a, TODAY));

  const weekly = await run("--workspace", a.workspace.id, "--week", WEEK);
  assert.deepEqual(weekly, { code: 0, lines: [written(keyOf(a, WEEK), 2, 1), total(2, 1, 1, 1)] });
  const labels = (await stored(a, keyOf(a, WEEK))).map((line) => line.label);
  assert.deepEqual(labels, ["positive", "not_positive"]);
  assert.deepEqual(await stored(a, keyOf(a, TODAY)), dayFile, "the day's full file stays");
  assert.deepEqual(await listed(a), [keyOf(a, TODAY), keyOf(a, WEEK)].sort());
  assert.deepEqual(await listed(b), [], "--workspace writes no other workspace's file");

  const both = await run("--week", WEEK);
  assert.equal(both.code, 0);
  assert.equal(both.lines.at(-1), total(4, 2, 2, 1));
  const earlier = await run("--week", LAST_WEEK);
  assert.equal(earlier.code, 0);
  assert.equal(earlier.lines.at(-1), total(1, 1, 1, 1));
  assert.ok(earlier.lines.includes(written(keyOf(a, LAST_WEEK), 1, 1)));
  assert.ok(earlier.lines.includes(written(keyOf(b, LAST_WEEK), 0, 0)));
});

test("refused, writing nothing: an unknown workspace id or slug prints workspace_not_found and exits 1; a week its year does not have, one not started or a malformed one prints week_invalid and exits 2; a usage error prints the usage and exits 2", async () => {
  const { a, b } = await seeded();
  for (const named of ["wsp_missing", "no-such-slug", "Not a slug"]) {
    assert.deepEqual(await run("--workspace", named), {
      code: 1,
      lines: [`workspace_not_found: ${named}`],
    });
  }
  for (const week of ["2026-W60", "2026-W45", "soon"]) {
    assert.deepEqual(await run("--week", week), { code: 2, lines: [`week_invalid: ${week}`] });
    const named = await run("--workspace", a.workspace.id, "--week", week);
    assert.deepEqual(named, { code: 2, lines: [`week_invalid: ${week}`] });
  }
  for (const args of [["--bogus"], ["extra"], ["--workspace"]]) {
    assert.deepEqual(await run(...args), { code: 2, lines: [USAGE] });
  }
  assert.deepEqual([await listed(a), await listed(b)], [[], []]);
});

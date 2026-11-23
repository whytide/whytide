// The reply numbers (gamma-p7-060; README.md "The report") against the worktree's database, in a
// schema of its own (withTestDb), on rows in end states and a fixed --since: each workspace's facts
// read in its own tenant run as the report reads them, then the figures. The LinkedIn reply rate on
// signal-sourced leads; the positive rules (the owner's label over the model's, the suggestion, beta's
// word, the 90 days, the active weeks); the classifier's agreement and too_few. Made-up names only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { servicePrincipal } from "@whytide/platform";
import { createTwoWorkspaces, type TestTenant, useTenancyClient } from "@whytide/tenancy/testing";
import { AGREEMENT_MIN_REPLIES } from "../domain/report/constants.ts";
import { countedPositives, figures } from "../domain/report/figures.ts";
import { type ReplyFact, readFacts } from "../domain/report/read.ts";
import { isoWeek } from "../domain/report/week.ts";
import { DAY_MS, reportFixture } from "./report-fixtures.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useHashSalt("test-salt-".repeat(4));

/** The report's --since: every touch and reply below falls after it, but the earlier positives. */
const SINCE = new Date("2026-10-01T00:00:00.000Z");
/** A day of 2026 at noon UTC: `day("10-27")` is the Tuesday of 2026-W44. */
const day = (monthDay: string) => new Date(`2026-${monthDay}T12:00:00.000Z`);

/** The workspaces' facts, each read in its own tenant run, as the command reads them. */
async function factsOf(...tenants: TestTenant[]) {
  const runs = tenants.map(({ workspace }) =>
    withTenant(
      { workspaceId: workspace.id, principal: servicePrincipal("inbox") },
      () => readFacts(SINCE),
      { client: app },
    ),
  );
  return Promise.all(runs);
}

test("reply_rate_linkedin: 50 signal-sourced leads touched, 3 with a human reply, 1 with an out-of-office reply only, gives 0.06; imported leads, an untouched lead's reply, a reply the owner marked out of office, a bounce and a log row naming no step are left out", async () => {
  const [a] = await createTwoWorkspaces();
  const f = reportFixture(a.workspace.id);
  const touched: string[] = [];
  for (let i = 0; i < 50; i += 1) {
    const personId = await f.lead("signal");
    await f.touch(personId, day("10-20"), i % 2 === 0 ? "invite" : "message");
    touched.push(personId);
  }
  // Two touches of one lead count it once.
  await f.touch(touched[0] ?? "", day("10-27"), "message");
  // The three human replies: unclassified, the model's not_now, the owner's interested over an
  // out-of-office classification; one lead with two of them counts once.
  await f.reply(touched[0] ?? "", day("10-22"));
  await f.reply(touched[0] ?? "", day("10-23"), { classified: { label: "not_now" } });
  await f.reply(touched[1] ?? "", day("10-22"), { classified: { label: "not_now" } });
  await f.reply(touched[2] ?? "", day("10-22"), {
    owner: { classLabel: "interested" },
    classified: { label: "out_of_office" },
  });
  // No human reply: an out-of-office one, a bounce, and the owner's out_of_office over the model's
  // interested.
  await f.reply(touched[3] ?? "", day("10-22"), { classified: { label: "out_of_office" } });
  await f.reply(touched[4] ?? "", day("10-22"), { classified: { label: "bounce" } });
  await f.reply(touched[5] ?? "", day("10-22"), {
    owner: { classLabel: "out_of_office" },
    classified: { label: "interested" },
  });
  // Left out: imported leads, touched and replying; a signal-sourced lead never touched; a reply
  // before --since; the inbox's reply and a withdrawal on the log, which name no step.
  for (let i = 0; i < 4; i += 1) {
    const imported = await f.lead("imported");
    await f.touch(imported, day("10-20"));
    await f.reply(imported, day("10-22"));
  }
  const untouched = await f.lead("signal");
  await f.reply(untouched, day("10-22"));
  await f.reply(touched[6] ?? "", new Date(SINCE.getTime() - DAY_MS));
  await f.logWithoutStep(day("10-21"), "message");
  await f.logWithoutStep(day("10-21"), "withdraw");

  const { replyRateLinkedin } = figures(await factsOf(a), SINCE);
  assert.deepEqual(replyRateLinkedin, { touched: 50, replied: 3, share: 0.06 });
});

test("positive_week: a lead counted once in 90 days, the owner's not_interested cancelling the model's interested, a suggestion not counted, beta's positive counted; a week with no send leaves its workspace out of the mean", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ours = reportFixture(a.workspace.id);
  const theirs = reportFixture(b.workspace.id);
  // a sends in 2026-W44 and 2026-W45, none in 2026-W46; b in 2026-W45 only.
  await ours.touch("per_touched_1", day("10-27"));
  await ours.touch("per_touched_2", day("11-03"));
  await theirs.touch("per_touched_3", day("11-04"));
  // W44: the model's interested, then the owner's within 90 days, not counted again.
  await ours.reply("per_l1", day("10-28"), { classified: { label: "interested" } });
  await ours.reply("per_l1", day("11-04"), { owner: { classLabel: "interested" } });
  // Cancelled: the owner's not_interested over the model's interested; a suggestion.
  await ours.reply("per_l2", day("10-29"), {
    owner: { classLabel: "not_interested" },
    classified: { label: "interested" },
  });
  await ours.reply("per_l3", day("11-04"), {
    classified: { label: "interested", isSuggested: true },
  });
  // W45: beta's positive, with no class; a lead whose last counted event is more than 90 days back.
  await ours.reply("per_l4", day("11-05"), { owner: { beta: "positive" } });
  await ours.reply("per_l6", day("07-20"), { owner: { classLabel: "interested" } });
  await ours.reply("per_l6", day("11-03"), { owner: { classLabel: "interested" } });
  // Not in W45: a lead counted in September, positive again 55 days later.
  await ours.reply("per_l7", day("09-10"), { owner: { classLabel: "interested" } });
  await ours.reply("per_l7", day("11-04"), { owner: { classLabel: "interested" } });
  // W46, no send: out of the mean.
  await ours.reply("per_l5", day("11-10"), { owner: { classLabel: "interested" } });

  const facts = await factsOf(a, b);
  const { positive } = figures(facts, SINCE);
  const expected = [
    { workspaceId: a.workspace.id, week: "2026-W44", positives: 1 },
    { workspaceId: a.workspace.id, week: "2026-W45", positives: 2 },
    { workspaceId: b.workspace.id, week: "2026-W45", positives: 0 },
  ];
  assert.deepEqual(positive, { weeks: expected, mean: 1 });
  const weeks = countedPositives(facts[0]?.replies ?? [])
    .map(isoWeek)
    .sort();
  assert.deepEqual(weeks, ["2026-W30", "2026-W37", "2026-W44", "2026-W45", "2026-W45", "2026-W46"]);
});

test("countedPositives: the first positive event, then the next at 90 days or more after the last counted, per lead", () => {
  const at = (days: number) => new Date(Date.UTC(2026, 0, 1) + days * DAY_MS);
  const positive = (personId: string, days: number): ReplyFact => ({
    ...{ personId, channel: "linkedin", sentAt: at(days) },
    owner: { classLabel: "interested", label: "positive" },
    classification: null,
  });
  const counted = countedPositives([
    positive("per_a", 0),
    positive("per_a", 89),
    positive("per_a", 90),
    positive("per_a", 179),
    positive("per_a", 200),
    positive("per_b", 89),
  ]).map((date) => date.getTime());
  assert.deepEqual(
    counted.sort(),
    [at(0), at(89), at(90), at(200)].map((date) => date.getTime()).sort(),
  );
});

test("classifier_agreement: on 30 pairs of an owner's label and a classification, whatever its origin, the F1 of interested and the share of the owner's opt-outs classified opt_out; too_few under 30; a reply with one of the two is no pair", async () => {
  const [a, b] = await createTwoWorkspaces();
  const f = reportFixture(a.workspace.id);
  const at = day("10-20");
  const pair = (
    classLabel: "interested" | "not_interested" | "not_now" | "opt_out",
    label: string,
    origin?: "phrase",
  ) => f.reply("per_agree", at, { owner: { classLabel }, classified: { label, origin } });
  // 9 true positives, 1 false negative, 1 false positive: F1 = 18 / 20.
  for (let i = 0; i < 9; i += 1) await pair("interested", "interested");
  await pair("interested", "not_now");
  await pair("not_interested", "interested");
  // 4 owner opt-outs, 3 classified opt_out, one by the phrases: 0.75.
  await pair("opt_out", "opt_out", "phrase");
  await pair("opt_out", "opt_out");
  await pair("opt_out", "opt_out");
  await pair("opt_out", "not_interested");
  for (let i = 0; i < 14; i += 1) await pair("not_now", "not_now");
  // No pair: an owner's label alone, a classification alone.
  await f.reply("per_agree", at, { owner: { classLabel: "interested" } });
  await f.reply("per_agree", at, { classified: { label: "interested" } });
  const short = figures(await factsOf(a), SINCE).agreement;
  assert.deepEqual(short, { pairs: AGREEMENT_MIN_REPLIES - 1, tooFew: true });

  await pair("not_now", "not_now");
  const { agreement } = figures(await factsOf(a), SINCE);
  assert.deepEqual(agreement, { pairs: 30, tooFew: false, f1Interested: 0.9, optOutShare: 0.75 });
  // Across workspaces: b's pairs add to a's.
  const g = reportFixture(b.workspace.id);
  await g.reply("per_other", at, {
    owner: { beta: "positive" },
    classified: { label: "interested" },
  });
  const both = figures(await factsOf(a, b), SINCE).agreement;
  assert.equal(both.pairs, 31);
  assert.ok(!both.tooFew && Math.abs((both.f1Interested ?? 0) - 20 / 22) < 1e-9);
});

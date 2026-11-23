// The thread owner's label (gamma-p4-055; README.md "API", "The classifier"; docs/flows.md "The
// label"): each of the 7 labels recorded with beta's word that follows it, and campaigns' default
// action run in the label's own tenant run on the person's newest reply; a suggestion changed; a
// confident label acting alone, and one chosen before the classifier answers; an older reply's label,
// recorded, acting on nothing but its opt-out; the same label again; the refusals, which write
// nothing; beta's golden set still in two words; the CHECK. On a schema of the worktree's database,
// in tenant runs as the route has them, on the LLM fake. Made-up names only.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { REPLY_ACTION_LABELS, type ReplyActionLabel } from "@whytide/campaigns";
import { useHashSalt } from "@whytide/contacts/testing";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useLinkedinClient } from "@whytide/linkedin/testing";
import { isAppError, servicePrincipal } from "@whytide/platform";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { MS_PER_DAY } from "../domain/classify/constants.ts";
import { exportReplyLabels } from "../domain/export/reply-labels.ts";
import { setLabel } from "../domain/labels/label.ts";
import { listThreads } from "../domain/threads/queries.ts";
import { createLabel, createMessage, useInboxExportClient } from "../testing/index.ts";
import { answer, classifyFixture, llm } from "./classify-fixtures.ts";
import { HELD, OWNER } from "./fixtures.ts";
import { human } from "./reply-fixtures.ts";

withTestDb();
useHashSalt("test-salt-".repeat(4));
useLinkedinClient(asRole("app"));
useTenancyClient(asRole("app"));
useInboxExportClient(asRole("app"));
/** A workspace id the files port takes: the golden set writes its file there. */
const WORKSPACE = "wsp_inboxlabel";
/** A member of the workspace who owns none of its threads. */
const MEMBER = "usr_inbox_member";
/** campaigns' CAMPAIGNS_NOT_NOW_REMINDER_DAYS and CAMPAIGNS_NOT_INTERESTED_COOL_DOWN_DAYS, unset. */
const REMINDER_DAYS = 30;
const COOL_DOWN_DAYS = 180;
const fx = classifyFixture(WORKSPACE);
const { app, run, account, enrolled, person, reply, classify, rowOf } = fx;
const { optOutChannels, stepsOf, leadOf } = fx;
const theirs = classifyFixture("wsp_inboxlabelother");
beforeEach(() => llm.reset());

/** Persons enrolled on the owner's account, one each slug: a member has one account a workspace. */
async function persons(...slugs: string[]) {
  const { id: senderAccountId } = await account();
  const people: { senderAccountId: string; personId: string }[] = [];
  for (const slug of slugs) {
    people.push({ senderAccountId, personId: await enrolled(senderAccountId, slug) });
  }
  return people;
}

/** The label as the route sets it, in the request's tenant run: the thread's owner's by default. */
const label = (messageId: string, value: ReplyActionLabel, by = OWNER) =>
  run(() => setLabel(messageId, value, by));
const labelRow = (messageId: string) =>
  app().replyLabel.findFirst({
    where: { messageId },
    select: { label: true, classLabel: true, labeledBy: true, labeledAt: true },
  });
/** The notices campaigns published: one mail to the owner each. */
const notices = () =>
  app().outboxEntry.count({
    where: { workspaceId: WORKSPACE, eventName: "campaigns.reply_notice_due" },
  });
const enrollmentOf = (personId: string) =>
  app().enrollment.findFirstOrThrow({ where: { personId } });
const sentAtOf = async (messageId: string) =>
  (await app().message.findFirstOrThrow({ where: { id: messageId } })).sentAt;
const daysAfter = (at: Date, days: number) => new Date(at.getTime() + days * MS_PER_DAY);
const refused = (code: string) => (error: unknown) => isAppError(error) && error.code === code;
/** The steps after a label that cancels the held ones with the reason. */
const cancelled = (reason: string) =>
  HELD.map(([key, status]) =>
    status === "held" ? [key, "cancelled", reason] : [key, status, null],
  );

test("each of the 7 labels on the person's newest reply: the row holds the class and beta's word, positive for interested alone, and campaigns' default action runs in the label's run", async () => {
  const slugs = REPLY_ACTION_LABELS.map((value) => `label-${value.replaceAll("_", "-")}`);
  const people = await persons(...slugs);
  for (const [index, value] of REPLY_ACTION_LABELS.entries()) {
    const { senderAccountId, personId } = people[index] ?? assert.fail(value);
    const ids = await reply(personId, senderAccountId, "Thanks for writing.");
    const before = await notices();

    const chosen = await label(ids.messageId, value);

    const word = value === "interested" ? "positive" : "not_positive";
    assert.deepEqual([chosen.label, chosen.classLabel, chosen.labeledBy], [word, value, OWNER]);
    assert.deepEqual(await labelRow(ids.messageId), chosen, `${value}: the row as answered`);
    const enrollment = await enrollmentOf(personId);
    assert.equal(enrollment.replyLabel, value, `${value}: recorded on the enrollment`);
    const repliedAt = await sentAtOf(ids.messageId);
    const steps = await stepsOf(personId);
    assert.equal(await notices(), before + (value === "interested" ? 1 : 0), `${value}: notices`);
    if (value === "not_now") {
      assert.deepEqual(
        [enrollment.remindAt?.getTime(), enrollment.remindUserId],
        [daysAfter(repliedAt, REMINDER_DAYS).getTime(), OWNER],
      );
    }
    if (value === "not_interested") {
      assert.deepEqual(steps, cancelled("not_interested"));
      const until = daysAfter(repliedAt, COOL_DOWN_DAYS).getTime();
      assert.equal(enrollment.coolDownUntil?.getTime(), until, "the cool-down");
    } else if (value === "opt_out") {
      assert.deepEqual(steps, cancelled("opted_out"));
      assert.equal(await leadOf(personId), "suppressed");
      assert.deepEqual(await optOutChannels(), ["all"], "on every channel, in the label's run");
    } else if (value === "out_of_office") {
      assert.deepEqual([enrollment.status, enrollment.pausedReason], ["paused", "out_of_office"]);
    } else {
      assert.deepEqual(steps, HELD, `${value}: the steps stay held`);
    }
  }
});

test("a suggested label changed to not_interested stops the person with the cool-down; the row holds not_interested and not_positive; no notice", async () => {
  const { senderAccountId, personId } = await person("label-changed");
  const ids = await reply(personId, senderAccountId, "Maybe. What would it cost?");
  llm.script(answer("interested", 0.55));
  await classify(ids);
  assert.deepEqual(await stepsOf(personId), HELD, "a suggestion acts on nothing");

  const chosen = await label(ids.messageId, "not_interested");

  const row = await labelRow(ids.messageId);
  assert.deepEqual([row?.classLabel, row?.label], ["not_interested", "not_positive"]);
  assert.deepEqual(row, chosen);
  assert.deepEqual(await stepsOf(personId), cancelled("not_interested"));
  const until = daysAfter(await sentAtOf(ids.messageId), COOL_DOWN_DAYS);
  assert.equal((await enrollmentOf(personId)).coolDownUntil?.getTime(), until.getTime());
  assert.equal(await notices(), 0);
  // The list answers its caller's own threads (gamma-p6-060): the thread's owner reads it.
  const principal = human(OWNER, WORKSPACE);
  const owners = { workspaceId: WORKSPACE, principal };
  const { threads } = await withTenant(owners, () => listThreads({ limit: 50 }), {
    client: app(),
  });
  assert.deepEqual(
    threads.map(({ classification, toLabel }) => [classification, toLabel]),
    [[{ label: "not_interested", isSuggested: false }, 0]],
    "the thread shows the owner's label, no longer the suggestion",
  );
});

test("a confident label acts without confirmation, and the owner's same label after it sends no second notice; a label the owner chose before the classifier answers is the one that acts", async () => {
  const [sure, early] = await persons("label-confident", "label-before-classifier");
  assert.ok(sure && early);
  const first = await reply(sure.personId, sure.senderAccountId, "Yes, Tuesday works.");
  llm.script(answer("interested", 0.9));
  await classify(first);
  assert.equal(await notices(), 1, "its notice, unconfirmed");
  await label(first.messageId, "interested");
  assert.equal(await notices(), 1, "campaigns' repeat rule: no second notice");

  const second = await reply(early.personId, early.senderAccountId, "Next quarter, maybe.");
  await label(second.messageId, "not_now");
  llm.script(answer("interested", 0.95));

  await classify(second);

  const row = await rowOf(second.messageId);
  assert.deepEqual([row.label, row.isSuggested], ["interested", false], "the classifier's row");
  assert.deepEqual(row.actionsTaken, { actions: [], enrollmentIds: [] }, "it acted on nothing");
  assert.equal(await notices(), 1, "no notice for the classifier's interested");
  const enrollment = await enrollmentOf(early.personId);
  const remindAt = daysAfter(await sentAtOf(second.messageId), REMINDER_DAYS);
  assert.deepEqual(
    [enrollment.replyLabel, enrollment.remindAt?.getTime()],
    ["not_now", remindAt.getTime()],
    "the owner's not_now acted",
  );
  assert.deepEqual(await stepsOf(early.personId), HELD);
});

test("an older reply's label is recorded and acts on nothing but its opt-out, which suppresses wherever it is found", async () => {
  const { senderAccountId, personId } = await person("label-older");
  const older = await reply(personId, senderAccountId, "Interesting.", { minutesAgo: 30 });
  const earlier = await reply(personId, senderAccountId, "Who are you?", { minutesAgo: 20 });
  await reply(personId, senderAccountId, "Busy this week.", { minutesAgo: 5 });

  const chosen = await label(older.messageId, "interested");

  assert.deepEqual([chosen.label, chosen.classLabel], ["positive", "interested"]);
  assert.deepEqual(await labelRow(older.messageId), chosen, "recorded");
  assert.equal(await notices(), 0, "no notice");
  assert.deepEqual(await stepsOf(personId), HELD);
  assert.equal(
    (await enrollmentOf(personId)).replyLabel,
    null,
    "nothing recorded on the enrollment",
  );
  await label(older.messageId, "not_interested");
  assert.deepEqual(await stepsOf(personId), HELD, "an older not_interested cancels nothing");
  assert.deepEqual(await optOutChannels(), []);

  await label(earlier.messageId, "opt_out");

  assert.equal(await leadOf(personId), "suppressed");
  assert.deepEqual(await optOutChannels(), ["all"]);
});

test("the same label again changes nothing: the row keeps its time and no second notice goes", async () => {
  const { senderAccountId, personId } = await person("label-again");
  const ids = await reply(personId, senderAccountId, "Sounds good, tell me more.");
  const first = await label(ids.messageId, "interested");
  assert.equal(await notices(), 1);

  const again = await label(ids.messageId, "interested");

  assert.deepEqual(again, first);
  assert.deepEqual(await labelRow(ids.messageId), first, "the row as it was");
  assert.equal(await notices(), 1, "no second notice");
  assert.equal(await app().replyLabel.count({ where: { messageId: ids.messageId } }), 1);
});

test("refused, nothing written: another member's message, another workspace's and an unknown one inbox_message_not_found; an outbound message message_not_inbound", async () => {
  const { senderAccountId, personId } = await person("label-refused");
  const ids = await reply(personId, senderAccountId, "Not sure yet.");
  const other = await theirs.person("label-theirs");
  const foreign = await theirs.reply(other.personId, other.senderAccountId, "Hello there.");
  const thread = { workspaceId: WORKSPACE, threadId: ids.threadId, personId };
  const outbound = await createMessage({ ...thread, direction: "out", sentBy: "user" });
  const notFound = refused("inbox_message_not_found");

  await assert.rejects(label(ids.messageId, "opt_out", MEMBER), notFound, "another member's");
  await assert.rejects(label(foreign.messageId, "opt_out"), notFound, "another workspace's");
  await assert.rejects(label("msg_unknown", "interested"), notFound, "unknown");
  await assert.rejects(label(outbound, "interested"), refused("message_not_inbound"));

  assert.equal(await app().replyLabel.count(), 0);
  assert.deepEqual(await stepsOf(personId), HELD);
  assert.deepEqual(await optOutChannels(), [], "no opt-out");
  assert.equal(await leadOf(personId), "replied", "not suppressed");
  assert.equal(await notices(), 0);
});

test("beta's golden set still reads beta's two words: interested positive, every other label not_positive", async () => {
  const [a, b] = await persons("label-export-a", "label-export-b");
  assert.ok(a && b);
  const yes = await reply(a.personId, a.senderAccountId, "Yes please.");
  const later = await reply(b.personId, b.senderAccountId, "Later, thanks.");
  await label(yes.messageId, "interested");
  await label(later.messageId, "not_now");

  const tenant = { workspaceId: WORKSPACE, principal: servicePrincipal("inbox_test") };
  const file = await exportReplyLabels(tenant, {});

  const lines = file.body
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as { label: string });
  assert.deepEqual(
    lines.map(({ label }) => label),
    ["positive", "not_positive"],
  );
  assert.deepEqual([file.lines, file.positive], [2, 1]);
});

test("the CHECK reply_labels_class_label: one of the 7 with its word, or no class on beta's rows; it refuses another class and a word that does not follow the class", async () => {
  const { senderAccountId, personId } = await person("label-check");
  const { messageId } = await reply(personId, senderAccountId, "Hello.");
  const row = { workspaceId: WORKSPACE, messageId, labeledBy: OWNER };
  for (const classLabel of REPLY_ACTION_LABELS) {
    const id = await createLabel({ ...row, classLabel });
    await app().replyLabel.delete({ where: { id } });
  }
  for (const word of ["positive", "not_positive"] as const) {
    const id = await createLabel({ ...row, label: word });
    await app().replyLabel.delete({ where: { id } });
  }
  const check = /reply_labels_class_label/;
  const maybe = "maybe" as ReplyActionLabel;
  await assert.rejects(createLabel({ ...row, classLabel: maybe, label: "not_positive" }), check);
  await assert.rejects(
    createLabel({ ...row, classLabel: "interested", label: "not_positive" }),
    check,
  );
  await assert.rejects(createLabel({ ...row, classLabel: "not_now", label: "positive" }), check);
});

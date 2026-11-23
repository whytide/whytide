// The Hot alert (README "The Hot alert", docs/flows.md "The Hot alert") on the worktree's database,
// with the app-mail fake (the test script's PROVIDER_APP_MAIL=fake): an intent write that takes the
// lead into Hot publishes qualification.lead_hot, ids only; its subscriber, in the delivery's run,
// claims hot_alerted_at and starts qualification_hot_alert by the event's id, a start this file
// records (core/apps/worker/tests/qualification-hot-alert.test.ts runs it on the worker); the
// activity's mail goes to the member who created the why-now signal's source, with the kind, the age
// and the lead's link, and none of the person's data. A second update while Hot publishes nothing
// and a redelivery finds the claim; leaving Hot clears it, and coming back mails again, without a
// link while APP_PUBLIC_ORIGIN is empty. A member who left gets nothing, as an unknown creator does,
// the claim kept. The log lines hold ids only.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createLeadForPerson } from "@whytide/contacts";
import { asRole, withTestDb } from "@whytide/db/testing";
import {
  bindWorkflowStarter,
  collectLogs,
  createLogger,
  subscribersOf,
  type WorkflowStart,
} from "@whytide/platform";
import { appMailConfig, appMailPort, getAdapter } from "@whytide/providers";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { mailHotLead, useAlertLog } from "../domain/alert/mail.ts";
import { assessPerson } from "../domain/assess/assess-person.ts";
import { scoreSnapshot, updateIntent } from "../domain/score/score-snapshot.ts";
import { type IntentInput, useSignalReader } from "../domain/signal-reader.ts";
import { hotAlertStart } from "../events.ts";
import { answer, COMPANY, contextOf, fake, PERSON, run, seed } from "./fixtures/assess.ts";

// Nothing here may reach a real mailbox: the fake, or no test at all.
if (appMailConfig.PROVIDER_APP_MAIL !== "fake") throw new Error("PROVIDER_APP_MAIL must be fake");

withTestDb();
useTenancyClient(asRole("app"));
const logs = collectLogs();
useAlertLog(createLogger({ destination: logs.destination }));
type SentMail = { readonly to: string; readonly subject: string; readonly text: string };
const mails = (await getAdapter(appMailPort, "fake")) as unknown as {
  sent(): readonly SentMail[];
};

const LEAD_HOT = "qualification.lead_hot";
const ORIGIN = "https://app.example.test";
const T0 = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 3_600_000;
const after = (hours: number) => new Date(T0.getTime() + hours * HOUR);
/** What the person is, which no mail and no log line may hold. */
const PERSON_DATA = [
  PERSON.firstName,
  PERSON.lastName,
  PERSON.headline,
  PERSON.title,
  PERSON.linkedinUrl,
  "adaeze",
  COMPANY.name,
  COMPANY.domain,
];

const items: IntentInput[] = [];
useSignalReader({
  intentInputs: async ({ personIds }) => items.filter((item) => personIds.includes(item.personId)),
  excerpts: async () => [],
});

/** A comment of the person's, rated 1 and `other`, on a source that `ownerUserId` created. */
const signal = (
  personId: string,
  eventId: string,
  kind: IntentInput["kind"],
  ownerUserId: string | null,
  at = T0,
): IntentInput => ({
  ...{ personId, eventId, sourceId: `src_${eventId}`, kind, role: "comment", relevance: 1 },
  ...{ intentClass: "other", occurredAt: at, ownerUserId, count: 1 },
});

/**
 * A workspace with its Owner and a Member, who creates the sources, and the fixture person's lead
 * decided at T0 with no signal yet: fit 88, priority 48, Cool.
 */
async function decidedLead() {
  const [{ workspace, user: owner }] = await createTwoWorkspaces();
  const workspaceId = workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const personId = await seed(workspaceId);
  const source = { kind: "imported", ref: "imp_1" } as const;
  await run(workspaceId, () => createLeadForPerson({ personId, source }));
  fake.reset();
  fake.script(answer());
  const assessed = await assessPerson({ personId, icpVersion: 1 }, contextOf(workspaceId));
  if (assessed.status !== "assessed") throw new Error(assessed.status);
  await run(workspaceId, () => scoreSnapshot(assessed.snapshotId, T0));
  return { workspaceId, owner, member, personId };
}

const hotEvents = (workspaceId: string) =>
  run(workspaceId, (tx) =>
    tx.outboxEntry.findMany({ where: { eventName: LEAD_HOT }, orderBy: { createdAt: "asc" } }),
  );
const rowOf = (workspaceId: string, personId: string) =>
  run(workspaceId, (tx) => tx.intentScore.findFirstOrThrow({ where: { personId } }));
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);
/** The activity's work, as the worker runs it, the signal's age as of `now`. */
const mailOf = (workspaceId: string, personId: string, now: Date) =>
  mailHotLead({ workspaceId, tenant: (fn) => run(workspaceId, fn) }, personId, now);

/** The event delivered as the worker's outbox does, its subscribers in one tenant run: the starts. */
async function deliver(workspaceId: string, entry: { id: string; payload: unknown }) {
  const starts: WorkflowStart[] = [];
  const unbind = bindWorkflowStarter({
    start: async (request) => {
      starts.push(request);
      return { started: true };
    },
  });
  try {
    await run(workspaceId, async (tx) => {
      const context = { id: entry.id, name: LEAD_HOT, workspaceId, createdAt: T0, attempt: 1, tx };
      for (const handler of subscribersOf(LEAD_HOT)) await handler(entry.payload, context);
    });
  } finally {
    unbind();
  }
  return starts;
}

/** The person's update at `at`, its lead_hot events after it and the newest of them. */
async function updated(workspaceId: string, personId: string, at: Date) {
  assert.equal(await run(workspaceId, () => updateIntent(personId, at)), true);
  const events = await hotEvents(workspaceId);
  return { events, last: events.at(-1) };
}

test("a lead that turns Hot: lead_hot with ids only, claimed and started by its id; one mail to the source's creator with the kind, the age and the link, none of the person's data; a second update sends nothing; out of Hot and back, a second mail, with no link while the origin is empty", async () => {
  const { workspaceId, owner, member, personId } = await decidedLead();
  assert.deepEqual(await hotEvents(workspaceId), [], "Cool: no event");

  // A competitor comment at T0: intent 53, priority 72 + 10, Hot.
  items.push(signal(personId, "evt_1", "competitor_engagement", member.id));
  const entered = await updated(workspaceId, personId, T0);
  assert.equal(entered.events.length, 1);
  const first = entered.last;
  assert.ok(first);
  assert.deepEqual(first.payload, { workspaceId, personId }, "ids only");
  assert.equal((await rowOf(workspaceId, personId)).hotAlertedAt, null, "not claimed yet");

  assert.deepEqual(await deliver(workspaceId, first), [
    hotAlertStart(workspaceId, personId, first.id),
  ]);
  const claimed = (await rowOf(workspaceId, personId)).hotAlertedAt;
  assert.ok(claimed instanceof Date, "claimed in the delivery's run");

  process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  assert.deepEqual(await mailOf(workspaceId, personId, after(50)), { sent: true });
  const [mail, ...more] = mailsTo(member.email);
  assert.ok(mail);
  assert.equal(more.length, 0, "one mail");
  assert.equal(mail.subject, "A lead turned Hot in Whytide");
  assert.match(mail.text, /^Why now: a comment on a competitor’s post, 2 days ago\.$/m);
  const link = `${ORIGIN}/w/${workspaceId}/leads/${personId}`;
  assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the lead's link, alone");
  const whole = `${mail.subject}\n${mail.text}`.toLowerCase();
  for (const value of PERSON_DATA) assert.ok(!whole.includes(value.toLowerCase()), value);
  assert.deepEqual(mailsTo(owner.email), [], "the Owner created no source");

  // An hour on, still Hot: no event; the first delivered again finds the claim and starts none.
  assert.equal((await updated(workspaceId, personId, after(1))).events.length, 1);
  assert.deepEqual(await deliver(workspaceId, first), []);
  assert.deepEqual((await rowOf(workspaceId, personId)).hotAlertedAt, claimed);

  // Three days on, the boost is over: 70, Warm, the claim cleared; the person's own post, Hot again.
  assert.equal((await updated(workspaceId, personId, after(72))).events.length, 1);
  const warm = await rowOf(workspaceId, personId);
  assert.deepEqual([warm.tier, warm.hotAlertedAt], ["warm", null]);
  items.push(signal(personId, "evt_2", "my_post_engagement", member.id, after(72)));
  const again = await updated(workspaceId, personId, after(72));
  assert.equal(again.events.length, 2);
  const second = again.last;
  assert.ok(second);
  assert.deepEqual(await deliver(workspaceId, second), [
    hotAlertStart(workspaceId, personId, second.id),
  ]);
  process.env.APP_PUBLIC_ORIGIN = "";
  try {
    assert.deepEqual(await mailOf(workspaceId, personId, after(73)), { sent: true });
  } finally {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  }
  const sent = mailsTo(member.email);
  assert.equal(sent.length, 2, "a second mail for the second entry");
  const last = sent[1];
  assert.ok(last);
  assert.match(last.text, /^Why now: a comment on your post, today\.$/m);
  assert.doesNotMatch(last.text, /https?:|\/w\//, "no link and no path");
  assert.match(last.text, /Open your leads in Whytide to see it\./);

  // The alert's lines: ids and the outcome, nothing of the person or the member.
  const lines = logs.lines().filter(({ msg }) => msg === "qualification: the Hot alert");
  const ids = { person_id: personId, user_id: member.id };
  assert.deepEqual(
    lines.map(({ person_id, user_id, outcome }) => ({ person_id, user_id, outcome })),
    [
      { ...ids, outcome: "sent" },
      { ...ids, outcome: "sent" },
    ],
  );
  const logged = JSON.stringify(logs.lines()).toLowerCase();
  for (const value of [...PERSON_DATA, member.email]) {
    assert.ok(!logged.includes(value.toLowerCase()), value);
  }
});

test("a member who left the workspace gets nothing, and the claim stays; a source whose creator is unknown alerts nobody either", async () => {
  const { workspaceId, member, personId } = await decidedLead();
  items.push(signal(personId, "evt_left", "competitor_engagement", member.id));
  const { last: entry } = await updated(workspaceId, personId, T0);
  assert.ok(entry);
  await asRole("app").membership.deleteMany({ where: { userId: member.id, workspaceId } });
  assert.equal((await deliver(workspaceId, entry)).length, 1);
  const before = mails.sent().length;
  assert.deepEqual(await mailOf(workspaceId, personId, after(1)), {
    sent: false,
    reason: "member_left",
  });
  assert.equal(mails.sent().length, before, "no mail");
  assert.ok((await rowOf(workspaceId, personId)).hotAlertedAt instanceof Date, "claim kept");

  // Out of Hot and back on a signal of a deleted source: no owner, no mail, the claim kept.
  await updated(workspaceId, personId, after(72));
  items.push(signal(personId, "evt_unknown", "my_post_engagement", null, after(72)));
  const { last: unknown } = await updated(workspaceId, personId, after(72));
  assert.ok(unknown && unknown.id !== entry.id);
  assert.equal((await deliver(workspaceId, unknown)).length, 1);
  assert.deepEqual(await mailOf(workspaceId, personId, after(73)), {
    sent: false,
    reason: "owner_unknown",
  });
  assert.equal(mails.sent().length, before, "no mail");
  assert.ok((await rowOf(workspaceId, personId)).hotAlertedAt instanceof Date, "claim kept");
});

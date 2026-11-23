// writeDraft for an email (domain/drafts/write.ts, docs/flows.md "A step's draft written";
// gamma-p3-070) as the draft workflow's activity calls it, on the LLM fake, against the worktree's
// database: the planner, then the email writer with an email's <channel> and <step>; a first email's
// subject and body, a follow-up's body alone; a regeneration after a link, after a subject on a
// follow-up and after a near duplicate of the mailbox; a lead's email draft written as the kind it
// was asked as, which its regeneration keeps, and its edit with its subject; a lead whose profile is
// in another language held back with no model call; the planner's v3 knows an email's step
// (gamma-p3-075). The gates' own cases are tests/gates.test.ts.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { createDraft, editDraft, regenerateDraft } from "../domain/drafts/store.ts";
import { writeDraft } from "../domain/drafts/write.ts";
import { gatesOf } from "../domain/gates/index.ts";
import { CHANNELS, WRITE_EMAIL } from "../schemas/writer.ts";
import { createMessageDraft, createStepDraft, useMessagingClient } from "../testing/index.ts";
import { contextOf, draftOf, fake, GROUNDED, PLAN, run, seed } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));
beforeEach(() => fake.reset());

/** A first email's body of 80 words that names only the lead's facts. */
const FIRST =
  "Ines, leads that go cold before sales calls them are a common problem for data teams at software companies like Acme. Signal Radar flags buying signals in public posts, so your team can reach warm leads while they still care. Northwind booked 40% more meetings in a quarter after they started using it. Lead Review then helps sales decide which leads to call first each morning. Would it be worth a short look at how this could work for Acme?";
/** Another of 72 words, unlike FIRST. */
const OTHER =
  "Ines, a data team like the one at Acme often hears about a buying signal only after the lead has gone cold. Signal Radar watches public posts every day and passes the warm leads to Lead Review, where sales can see why each one matters before calling. Northwind booked 40% more meetings in a quarter with it. Is following up on warm leads a problem your team is working on this quarter?";
/** A follow-up's body of 74 words. */
const FOLLOW_UP =
  "Ines, one more thought for Acme. Most data teams only see a buying signal days after it happened, when the lead has already moved on. Signal Radar reads public posts every day and sends the warm ones to Lead Review, where sales can see why each lead matters before they call. Northwind booked 40% more meetings in a quarter that way. Would a short walk through of Lead Review be useful for your team?";
const SUBJECT = "Warm leads at Acme";
const FIRST_CHANNEL = {
  channel: "email",
  minWords: 50,
  maxWords: 120,
  subject: { maxWords: 6, maxCharacters: 60 },
};

type Recorded = { system: string; messages: { content: { text: string }[] }[] };
/** The call's data blocks by name, each parsed. */
function blocks(index: number): Record<string, unknown> {
  const call = fake.recordedCalls[index]?.input as Recorded;
  const text = call.messages.flatMap(({ content }) => content.map((part) => part.text)).join("");
  const found = [...text.matchAll(/<([a-z_]+)>\n([\s\S]*?)\n<\/\1>/g)];
  return Object.fromEntries(found.map(([, name, value]) => [name, JSON.parse(value ?? "null")]));
}
const system = (index: number) => (fake.recordedCalls[index]?.input as Recorded).system;
const passed = (gates: readonly string[]) => gates.map((gate) => ({ gate, issues: [] }));
const row = (workspaceId: string, id: string) =>
  run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));

/** The fixture lead, and a `drafting` step email of the mailbox, `email_1` unless given. */
async function seeded() {
  const { workspaceId, personId, userId } = await seed();
  const email = (stepExecutionId: string, mailboxId: string, columns: object = {}) =>
    createStepDraft({
      workspaceId,
      personId,
      stepExecutionId,
      stepKey: "email_1",
      mailboxId,
      status: "drafting",
      text: null,
      ...columns,
    });
  const write = (draftId: string, more: object = {}) =>
    writeDraft({ draftId, userId, ...more }, contextOf(workspaceId));
  return { workspaceId, personId, email, write };
}

test("email_1: the planner, then the email writer with a first email's <channel> and <step>; a link in the body fails `links` and is regenerated; the trimmed subject and the body stored, `ready`, every email gate passed", async () => {
  const { workspaceId, email, write } = await seeded();
  const draftId = await email("sx_1", "mbx_1");
  const linked = `${FIRST} More at www.signalradar.com.`;
  fake.script(PLAN, { subject: SUBJECT, body: linked }, { subject: ` ${SUBJECT} `, body: FIRST });
  assert.deepEqual(await write(draftId), { status: "ready" });

  const [first, second] = [blocks(1), blocks(2)];
  assert.deepEqual([blocks(0).channel, first.channel], [FIRST_CHANNEL, FIRST_CHANNEL]);
  assert.deepEqual(first.step, { kind: "email_first", earlier: [] });
  const link = { gate: "links", link: "www.signalradar.com" };
  assert.deepEqual([first.failures, second.failures], [[], [[link]]]);
  assert.ok([1, 2].every((index) => system(index).includes("You write one email")));
  assert.ok(system(0).includes("`email_first`: the seller's first email to the lead."));
  const draft = await row(workspaceId, draftId);
  assert.deepEqual(
    [draft.status, draft.subject, draft.text, draft.regenerations, draft.promptVersion],
    ["ready", SUBJECT, FIRST, 1, 1],
  );
  assert.deepEqual(draft.gates, passed(gatesOf("email", { first: true, mailbox: true })));
  const records = await run(workspaceId, (tx) => tx.decisionRecord.findMany());
  assert.equal(records.filter(({ task }) => task === WRITE_EMAIL).length, 2);
  const plans = records.filter(({ task }) => task === "messaging.plan-message");
  assert.deepEqual(
    plans.map(({ promptVersion }) => promptVersion),
    [3],
  );
});

test("email_2: a follow-up with the earlier email's text in <step> and no subject in <channel>; a subject answered is `not_allowed` and regenerated; the body stored, no subject, no links gate", async () => {
  const { workspaceId, email, write } = await seeded();
  const sent = await email("sx_1", "mbx_1", { status: "approved", text: FIRST, subject: SUBJECT });
  const draftId = await email("sx_2", "mbx_1", { stepKey: "email_2" });
  fake.script(
    PLAN,
    { subject: "One more thought", body: FOLLOW_UP },
    { subject: null, body: FOLLOW_UP },
  );
  assert.deepEqual(await write(draftId, { earlierDraftIds: [sent] }), { status: "ready" });

  const [first, second] = [blocks(1), blocks(2)];
  assert.deepEqual(first.channel, { ...FIRST_CHANNEL, subject: null });
  assert.deepEqual(first.step, {
    kind: "email_follow_up",
    earlier: [{ stepKey: "email_1", text: FIRST }],
  });
  assert.deepEqual(second.failures, [[{ gate: "subject", problem: "not_allowed" }]]);
  const draft = await row(workspaceId, draftId);
  assert.deepEqual(
    [draft.status, draft.subject, draft.text, draft.mailboxId],
    ["ready", null, FOLLOW_UP, "mbx_1"],
  );
  assert.deepEqual(draft.gates, passed(gatesOf("email", { first: false, mailbox: true })));
});

test("near_duplicate: a body as another email of the mailbox today fails with the similarity alone and is regenerated; the same body from another mailbox is `ready` at once", async () => {
  const { workspaceId, email, write } = await seeded();
  await email("sx_sent", "mbx_1", { status: "approved", text: FIRST, subject: SUBJECT });
  const draftId = await email("sx_1", "mbx_1");
  fake.script(PLAN, { subject: SUBJECT, body: FIRST }, { subject: SUBJECT, body: OTHER });
  assert.deepEqual(await write(draftId), { status: "ready" });
  assert.deepEqual(blocks(2).failures, [[{ gate: "near_duplicate", similarity: 1 }]]);
  const draft = await row(workspaceId, draftId);
  assert.deepEqual([draft.text, draft.regenerations], [OTHER, 1]);

  fake.reset();
  const elsewhere = await email("sx_2", "mbx_2");
  fake.script(PLAN, { subject: SUBJECT, body: FIRST });
  assert.deepEqual(await write(elsewhere), { status: "ready" });
  assert.equal((await row(workspaceId, elsewhere)).regenerations, 0);
});

test("a lead's email draft asked as email_follow_up is written as one, with no subject, and its regeneration keeps the kind; asked with no kind, a first email; a kind off the channel is refused", async () => {
  const { workspaceId, personId, write } = await seeded();
  const create = (channel: (typeof CHANNELS)[number], stepKind?: "email_follow_up") =>
    run(workspaceId, () => createDraft({ personId, channel, ...(stepKind && { stepKind }) }));
  const asked = await create("email", "email_follow_up");
  fake.script(PLAN, { subject: null, body: FOLLOW_UP });
  assert.deepEqual(await write(asked.id), { status: "ready" });
  assert.deepEqual(blocks(1).step, { kind: "email_follow_up", earlier: [] });
  const draft = await row(workspaceId, asked.id);
  assert.deepEqual(
    [draft.stepKind, draft.subject, draft.text],
    ["email_follow_up", null, FOLLOW_UP],
  );
  assert.deepEqual(draft.gates, passed(gatesOf("email", { first: false })));

  const again = await run(workspaceId, () => regenerateDraft(asked.id));
  assert.deepEqual([again.channel, again.stepKind], ["email", "email_follow_up"]);
  fake.script(PLAN, { subject: null, body: OTHER });
  assert.deepEqual(await write(again.id, { replacesId: asked.id }), { status: "ready" });
  assert.deepEqual(blocks(3).step, { kind: "email_follow_up", earlier: [] });
  assert.equal((blocks(3).replaced as { text: string }).text, FOLLOW_UP);

  const plain = await create("email");
  fake.script(PLAN, { subject: SUBJECT, body: FIRST });
  assert.deepEqual(await write(plain.id), { status: "ready" });
  assert.deepEqual(blocks(5).step, { kind: "email_first", earlier: [] });
  assert.equal((await row(workspaceId, plain.id)).subject, SUBJECT);
  for (const channel of ["linkedin_note", "linkedin_message"] as const) {
    await assert.rejects(create(channel, "email_follow_up"), {
      code: "messaging_input_invalid",
      details: { fields: ["stepKind"] },
    });
  }
});

test("a lead's first email edited: its subject with its body, trimmed, kept by a later edit, through the gates; a subject on a follow-up or a LinkedIn draft is draft_subject_not_allowed and changes nothing", async () => {
  const { workspaceId, personId } = await seeded();
  const lead = (columns: object) =>
    createMessageDraft({ workspaceId, personId, text: FIRST, ...columns });
  const edit = (id: string, input: { editedText: string; editedSubject?: string }) =>
    run(workspaceId, () => editDraft(id, input));
  const first = await lead({ channel: "email", subject: SUBJECT });
  const subject = "Warm leads, sooner";
  const edited = await edit(first, { editedText: OTHER, editedSubject: `  ${subject} ` });
  assert.deepEqual(
    [edited.status, edited.editedText, edited.subject, edited.editedSubject],
    ["edited", OTHER, SUBJECT, subject],
  );
  assert.equal((await edit(first, { editedText: FIRST })).editedSubject, subject);
  const refused = { code: "draft_text_refused" };
  await assert.rejects(edit(first, { editedText: FIRST, editedSubject: "Re: leads" }), refused);
  await assert.rejects(edit(first, { editedText: `${FIRST} More at acme.io.` }), {
    ...refused,
    details: { issues: [{ gate: "links", link: "acme.io" }] },
  });
  const later = await lead({ channel: "email", stepKind: "email_follow_up" });
  const message = await lead({ channel: "linkedin_message", text: GROUNDED });
  for (const id of [later, message]) {
    const input = { editedText: GROUNDED, editedSubject: "Hi" };
    await assert.rejects(edit(id, input), { code: "draft_subject_not_allowed" });
    assert.equal((await row(workspaceId, id)).status, "ready");
  }
});

test("a lead whose own comment is in French: every channel's draft `failed`, profile_not_english, with no text, no model call and no decision record", async () => {
  const comment =
    "Exactement notre problème : nous perdons des leads chaque semaine, et les outils pour les relancer sont lents.";
  const { workspaceId, personId, userId } = await seed(comment);
  for (const channel of CHANNELS) {
    const draftId = await draftOf(workspaceId, personId, channel);
    const context = contextOf(workspaceId);
    assert.deepEqual(await writeDraft({ draftId, userId }, context), { status: "failed" }, channel);
    const draft = await row(workspaceId, draftId);
    assert.deepEqual(
      [draft.flagReasons, draft.text, draft.subject, draft.plan],
      [[{ code: "profile_not_english" }], null, null, null],
      channel,
    );
  }
  assert.equal(fake.recordedCalls.length, 0);
  assert.equal(await run(workspaceId, (tx) => tx.decisionRecord.count()), 0);
});

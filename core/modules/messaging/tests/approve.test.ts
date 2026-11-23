// approveStepDraft, approvedContent and stepDrafts (domain/drafts/approve.ts, domain/drafts/step.ts;
// README.md "Public interface"; beta-p3-020), each in a tenant run as approvals calls them, against
// the worktree's database: the refusals, the final text and its trim, the gates on every approval,
// the empty note, the edit ratio and edited_by_user, the content hash and two approvals at once; the
// frozen content; the step drafts as approvals reads them. A first email's subject frozen with its
// body, the email's hash, the subject's refusals and the email gates at approval (gamma-p3-070). A
// person's approval answers disclosureApplied false (gamma-p4-080; tests/disclosure.test.ts).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import {
  approvedContent,
  approveStepDraft,
  distance,
  editRatioOf,
} from "../domain/drafts/approve.ts";
import { stepDrafts } from "../domain/drafts/step.ts";
import { gatesOf } from "../domain/gates/index.ts";
import { createMessageDraft, createStepDraft, useMessagingClient } from "../testing/index.ts";
import { COLLEAGUE, GROUNDED, PLAN, run, seed, seedColleague } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The SHA-256 of "": a note left empty. */
const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const refusedWith = (...issues: object[]) => ({ code: "draft_text_refused", details: { issues } });
const emptyMessage = refusedWith({ gate: "length", length: 0, min: 1, max: 1_900 });

/** The fixture lead with a colleague at its company, and its step drafts' commands. */
async function seeded() {
  const { workspaceId, personId } = await seed();
  await seedColleague(workspaceId, personId);
  type Columns = Omit<Parameters<typeof createStepDraft>[0], "workspaceId" | "personId">;
  const step = (stepExecutionId: string, columns: Partial<Columns> = {}) =>
    createStepDraft({ workspaceId, personId, stepExecutionId, text: GROUNDED, ...columns });
  const approve = (draftId: string, stepExecutionId: string, text?: string) =>
    run(workspaceId, () =>
      approveStepDraft(draftId, { stepExecutionId, ...(text !== undefined && { text }) }),
    );
  const row = (id: string) =>
    run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));
  const content = (id: string) => run(workspaceId, () => approvedContent(id));
  return { workspaceId, personId, step, approve, row, content };
}

test("the refusals: an unknown draft or another workspace's draft_not_found, a lead's draft or another step's draft_step_mismatch, a drafting one draft_not_ready, an approved one draft_not_editable; none changes a row", async () => {
  const { workspaceId, personId, step, approve, row } = await seeded();
  await assert.rejects(approve("mdr_none", "sx_1"), { code: "draft_not_found" });
  await assert.rejects(approve("", "sx_1"), { code: "draft_not_found" });
  const theirs = await createStepDraft({
    workspaceId: "wsp_other",
    personId,
    stepExecutionId: "sx_theirs",
    text: GROUNDED,
  });
  await assert.rejects(approve(theirs, "sx_theirs"), { code: "draft_not_found" });
  const lead = await createMessageDraft({ workspaceId, personId, text: GROUNDED });
  await assert.rejects(approve(lead, "sx_1"), { code: "draft_step_mismatch" });
  const ready = await step("sx_ready");
  await assert.rejects(approve(ready, "sx_other"), { code: "draft_step_mismatch" });
  const drafting = await step("sx_drafting", { status: "drafting", text: null });
  await assert.rejects(approve(drafting, "sx_drafting"), { code: "draft_not_ready" });
  const approved = await step("sx_approved", { status: "approved" });
  await assert.rejects(approve(approved, "sx_approved"), { code: "draft_not_editable" });
  await assert.rejects(approve(ready, ""), {
    code: "messaging_input_invalid",
    details: { fields: ["stepExecutionId"] },
  });
  for (const [id, status] of [
    [lead, "ready"],
    [ready, "ready"],
    [drafting, "drafting"],
  ] as const) {
    const { status: now, editedText, approvedAt } = await row(id);
    assert.deepEqual([now, editedText, approvedAt], [status, null, null], id);
  }
});

test("the final text: the draft's own, or the owner's, trimmed; checkText runs on every approval: a colleague's signal, a colleague's name, a red line or a placeholder is draft_text_refused with its issue; a flagged draft passes once its final text does; a failed message only with a typed text", async () => {
  const { step, approve, row } = await seeded();
  const own = await step("sx_own");
  assert.deepEqual(await approve(own, "sx_own"), { contentHash: sha256(GROUNDED), editRatio: 0 });
  const stored = await row(own);
  assert.deepEqual(
    [stored.status, stored.text, stored.editedText, stored.editedAt, stored.editedByUser],
    ["approved", GROUNDED, null, null, false],
  );
  assert.deepEqual([Number(stored.editRatio), stored.approvedAt instanceof Date], [0, true]);
  const spaced = await step("sx_spaced");
  assert.deepEqual(await approve(spaced, "sx_spaced", `  ${GROUNDED}\n`), {
    contentHash: sha256(GROUNDED),
    editRatio: 0,
  });

  const target = await step("sx_target");
  const name = `${COLLEAGUE.firstName} ${COLLEAGUE.lastName}`;
  const refused: [string, object][] = [
    [
      `${GROUNDED} Your colleague liked it.`,
      { gate: "colleague_signal", phrase: "Your colleague" },
    ],
    [`${GROUNDED} So did ${name}.`, { gate: "colleague_signal", phrase: name }],
    [`As we discussed, ${GROUNDED}`, { gate: "red_lines", phrase: "as we discussed" }],
    [`Hi {{first_name}}. ${GROUNDED}`, { gate: "placeholders", placeholder: "{{first_name}}" }],
  ];
  for (const [text, issue] of refused) {
    await assert.rejects(approve(target, "sx_target", text), refusedWith(issue), text);
  }
  assert.equal((await row(target)).status, "ready");

  const signal = `${GROUNDED} Someone from your team liked it.`;
  const flagged = await step("sx_flagged", { status: "flagged", text: signal });
  const issue = { gate: "colleague_signal", phrase: "Someone from your team" };
  await assert.rejects(approve(flagged, "sx_flagged"), refusedWith(issue));
  const approval = await approve(flagged, "sx_flagged", GROUNDED);
  assert.deepEqual(approval, {
    contentHash: sha256(GROUNDED),
    editRatio: editRatioOf(signal, GROUNDED),
  });
  // Flagged by grounding alone, which is the writer's gate: the owner reads it and approves it.
  const globex = "Ines, Globex follows up on warm leads within the hour. Does your team?";
  const ungrounded = await step("sx_ungrounded", { status: "flagged", text: globex });
  assert.equal((await approve(ungrounded, "sx_ungrounded")).contentHash, sha256(globex));

  const failed = await step("sx_failed", { status: "failed", text: null });
  await assert.rejects(approve(failed, "sx_failed"), emptyMessage);
  await assert.rejects(approve(failed, "sx_failed", " \n "), emptyMessage);
  assert.deepEqual(await approve(failed, "sx_failed", GROUNDED), {
    contentHash: sha256(GROUNDED),
    editRatio: 1,
  });
  const typed = await row(failed);
  assert.deepEqual(
    [typed.status, typed.text, typed.editedText, typed.editedByUser],
    ["approved", null, GROUNDED, true],
  );
  assert.ok(typed.editedAt instanceof Date);
});

test("an empty text approves a step's note, hashed as \"\", and is refused for a message; a typed note is the owner's own text", async () => {
  const { step, approve, row, content } = await seeded();
  const note = await step("sx_note", { stepKey: "connect", text: "" });
  assert.deepEqual(await approve(note, "sx_note", ""), { contentHash: EMPTY_HASH, editRatio: 0 });
  assert.deepEqual(await content(note), {
    text: "",
    contentHash: EMPTY_HASH,
    disclosureApplied: false,
  });
  const left = await step("sx_left", { stepKey: "connect", text: "" });
  assert.deepEqual(await approve(left, "sx_left", "   "), {
    contentHash: EMPTY_HASH,
    editRatio: 0,
  });
  assert.equal((await row(left)).editedByUser, false);

  const message = await step("sx_message");
  await assert.rejects(approve(message, "sx_message", ""), emptyMessage);
  assert.equal((await row(message)).status, "ready");

  const typed = "Ines, a question about warm leads?";
  const noted = await step("sx_noted", { stepKey: "connect", text: "" });
  assert.deepEqual(await approve(noted, "sx_noted", typed), {
    contentHash: sha256(typed),
    editRatio: 1,
  });
  const stored = await row(noted);
  assert.deepEqual([stored.editedText, stored.editedByUser], [typed, true]);
});

test("the edit ratio: 0 untouched, 1 typed over nothing, the distance over the longer length for a known pair, three decimals; edited_by_user follows the trimmed texts", async () => {
  assert.deepEqual([distance("kitten", "sitting"), editRatioOf("kitten", "sitting")], [3, 0.429]);
  assert.deepEqual(
    [editRatioOf("", ""), editRatioOf("same", "same"), editRatioOf("", "typed")],
    [0, 0, 1],
  );
  const { step, approve, row } = await seeded();
  const written = "Ines, a question about warm leads?";
  const pair = await step("sx_pair", { text: written });
  const edited = "Ines, one question about warm leads?";
  assert.equal((await approve(pair, "sx_pair", edited)).editRatio, 0.083);
  const stored = await row(pair);
  assert.deepEqual([Number(stored.editRatio), stored.editedByUser], [0.083, true]);

  // A stored text with a trailing space, approved as it is: no edit by the owner, and the frozen
  // text is the trimmed one, exactly what the hash covers.
  const padded = await step("sx_padded", { text: `${GROUNDED} ` });
  assert.deepEqual(await approve(padded, "sx_padded"), {
    contentHash: sha256(GROUNDED),
    editRatio: 0,
  });
  const frozen = await row(padded);
  assert.deepEqual([frozen.editedText, frozen.editedByUser], [GROUNDED, false]);
});

test("two approvals at once leave one approved row and one refusal, draft_not_editable; the frozen text is the winner's", async () => {
  const { step, approve, content } = await seeded();
  const raced = await step("sx_race");
  const texts = [GROUNDED, `${GROUNDED} Thanks!`];
  const results = await Promise.allSettled(texts.map((text) => approve(raced, "sx_race", text)));
  const won = results.findIndex((result) => result.status === "fulfilled");
  const lost = results.filter((result) => result.status === "rejected");
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.deepEqual(
    lost.map(({ reason }) => (reason as { code?: string }).code),
    ["draft_not_editable"],
  );
  const winner = texts[won] ?? "";
  assert.deepEqual(await content(raced), {
    text: winner,
    contentHash: sha256(winner),
    disclosureApplied: false,
  });
});

test("approvedContent answers the frozen text and its hash for an approved step draft only: null for every other status, a lead's draft and an unknown id", async () => {
  const { workspaceId, personId, step, content } = await seeded();
  for (const status of ["drafting", "ready", "flagged", "failed", "edited"] as const) {
    const id = await step(`sx_${status}`, { status, editedText: GROUNDED });
    assert.equal(await content(id), null, status);
  }
  const lead = await createMessageDraft({
    workspaceId,
    personId,
    status: "edited",
    text: GROUNDED,
  });
  assert.deepEqual(
    [await content(lead), await content("mdr_none"), await content("")],
    [null, null, null],
  );
  const own = `${GROUNDED} Thanks!`;
  const approved = await step("sx_approved", { status: "approved", editedText: own });
  assert.deepEqual(await content(approved), {
    text: own,
    contentHash: sha256(own),
    disclosureApplied: false,
  });
});

test("stepDrafts: the workspace's step drafts of the ids, in their order and once, each with its final text, limits, gates, reasons, plan's facts and edit measure; a lead's draft and an unknown id left out", async () => {
  const { workspaceId, personId, step, approve } = await seeded();
  const ready = await step("sx_ready", { plan: PLAN });
  const reasons = [{ code: "ai_failed" }];
  const failed = await step("sx_failed", { status: "failed", text: null, flagReasons: reasons });
  const note = await step("sx_note", { stepKey: "connect", text: "" });
  const typed = "Ines, a question about warm leads?";
  await approve(note, "sx_note", typed);
  const lead = await createMessageDraft({ workspaceId, personId, text: GROUNDED });
  const ids = [note, ready, "mdr_none", lead, failed, ready];
  const views = await run(workspaceId, () => stepDrafts(ids));
  assert.deepEqual(
    views.map(({ id }) => id),
    [note, ready, failed],
  );
  const [noteView, readyView, failedView] = views;
  const passed = gatesOf("linkedin_message").map((gate) => ({ gate, issues: [] }));
  assert.deepEqual(readyView, {
    id: ready,
    personId,
    stepExecutionId: "sx_ready",
    stepKey: "message_1",
    channel: "linkedin_message",
    status: "ready",
    text: GROUNDED,
    minCharacters: 1,
    maxCharacters: 1_900,
    subject: null,
    maxSubjectWords: null,
    maxSubjectCharacters: null,
    gates: passed,
    flagReasons: [],
    factIds: PLAN.factIds,
    editedByUser: false,
    editRatio: null,
    approvedAt: null,
  });
  assert.deepEqual(
    [failedView?.status, failedView?.text, failedView?.flagReasons, failedView?.factIds],
    ["failed", null, reasons, []],
  );
  const { text, minCharacters, maxCharacters, editedByUser, editRatio } = noteView ?? {};
  assert.deepEqual(
    { text, minCharacters, maxCharacters, editedByUser, editRatio, channel: noteView?.channel },
    {
      text: typed,
      minCharacters: 0,
      maxCharacters: 200,
      editedByUser: true,
      editRatio: 1,
      channel: "linkedin_note",
    },
  );
  assert.ok(noteView?.approvedAt instanceof Date);
  assert.deepEqual(await run(workspaceId, () => stepDrafts([])), []);
});

test("an email: a first one's subject frozen with its body, the owner's when given, trimmed, edited_subject when it differs, edited_by_user when either changed; the hash of { body, subject } changes with either; approvedContent answers the subject, null for a follow-up; a failed first email needs a typed subject and body", async () => {
  const { workspaceId, personId, row, content } = await seeded();
  const SUBJECT = "Warm leads at Acme";
  const email = (stepExecutionId: string, stepKey: "email_1" | "email_2", columns = {}) =>
    createStepDraft({
      ...{ workspaceId, personId, stepExecutionId, stepKey, mailboxId: `mbx_${stepExecutionId}` },
      ...{ text: GROUNDED, subject: stepKey === "email_1" ? SUBJECT : null, ...columns },
    });
  const approve = (id: string, stepExecutionId: string, input: object = {}) =>
    run(workspaceId, () => approveStepDraft(id, { stepExecutionId, ...input }));
  const hash = (body: string, subject: string | null) => sha256(JSON.stringify({ body, subject }));

  const own = await email("sx_own", "email_1");
  assert.deepEqual(await approve(own, "sx_own"), {
    contentHash: hash(GROUNDED, SUBJECT),
    editRatio: 0,
  });
  const frozen = {
    text: GROUNDED,
    subject: SUBJECT,
    contentHash: hash(GROUNDED, SUBJECT),
    disclosureApplied: false,
  };
  assert.deepEqual(await content(own), frozen);
  const untouched = await row(own);
  assert.deepEqual([untouched.editedSubject, untouched.editedByUser], [null, false]);

  const titled = await email("sx_titled", "email_1");
  const subject = "Warm leads, sooner";
  assert.deepEqual(await approve(titled, "sx_titled", { subject: `  ${subject} ` }), {
    contentHash: hash(GROUNDED, subject),
    editRatio: 0,
  });
  const stored = await row(titled);
  assert.deepEqual(
    [stored.subject, stored.editedSubject, stored.editedByUser],
    [SUBJECT, subject, true],
  );
  assert.equal((await content(titled))?.subject, subject);
  const bodied = await email("sx_bodied", "email_1");
  const body = `${GROUNDED} Thanks!`;
  assert.equal(
    (await approve(bodied, "sx_bodied", { text: body })).contentHash,
    hash(body, SUBJECT),
  );
  assert.equal(
    new Set([hash(GROUNDED, SUBJECT), hash(GROUNDED, subject), hash(body, SUBJECT)]).size,
    3,
  );

  const later = await email("sx_later", "email_2");
  assert.equal((await approve(later, "sx_later")).contentHash, hash(GROUNDED, null));
  assert.deepEqual(await content(later), {
    text: GROUNDED,
    subject: null,
    contentHash: hash(GROUNDED, null),
    disclosureApplied: false,
  });

  const failed = await email("sx_failed", "email_1", {
    status: "failed",
    text: null,
    subject: null,
  });
  const empty = { gate: "length", length: 0, min: 1, max: 1_900, unit: "characters" };
  const missing = { gate: "subject", problem: "missing" };
  await assert.rejects(approve(failed, "sx_failed"), refusedWith(empty, missing));
  await assert.rejects(approve(failed, "sx_failed", { text: GROUNDED }), refusedWith(missing));
  const typed = await approve(failed, "sx_failed", { text: GROUNDED, subject: SUBJECT });
  assert.deepEqual(typed, { contentHash: hash(GROUNDED, SUBJECT), editRatio: 1 });
  const done = await row(failed);
  assert.deepEqual(
    [done.editedText, done.editedSubject, done.editedByUser],
    [GROUNDED, SUBJECT, true],
  );
});

test("a subject on a follow-up or a LinkedIn draft is draft_subject_not_allowed; at approval a first email's link, any act phrase and a near duplicate of the mailbox are draft_text_refused; a follow-up may hold a link", async () => {
  const { workspaceId, personId, step, row } = await seeded();
  const approve = (id: string, stepExecutionId: string, input: object = {}) =>
    run(workspaceId, () => approveStepDraft(id, { stepExecutionId, ...input }));
  const email = (
    stepExecutionId: string,
    stepKey: "email_1" | "email_2",
    mailboxId: string,
    text = GROUNDED,
  ) =>
    createStepDraft({
      workspaceId,
      personId,
      stepExecutionId,
      stepKey,
      mailboxId,
      text,
      ...(stepKey === "email_1" && { subject: "Warm leads at Acme" }),
    });

  const later = await email("sx_later", "email_2", "mbx_1");
  const message = await step("sx_message");
  for (const [id, sx] of [
    [later, "sx_later"],
    [message, "sx_message"],
  ] as const) {
    await assert.rejects(approve(id, sx, { subject: "Hi" }), { code: "draft_subject_not_allowed" });
    assert.equal((await row(id)).status, "ready");
  }
  const first = await email("sx_first", "email_1", "mbx_2");
  const linked = `${GROUNDED} More at acme.io.`;
  await assert.rejects(
    approve(first, "sx_first", { text: linked }),
    refusedWith({ gate: "links", link: "acme.io" }),
  );
  const act = refusedWith({ gate: "signal_act", phrase: "Saw you liked" });
  await assert.rejects(approve(first, "sx_first", { subject: "Saw you liked it" }), act);
  await assert.rejects(
    approve(message, "sx_message", { text: `Saw you liked it. ${GROUNDED}` }),
    act,
  );
  const linkedLater = await email("sx_linked", "email_2", "mbx_3", linked);
  assert.ok((await approve(linkedLater, "sx_linked")).contentHash);

  // The first email of mbx_2 is approved: another draft of that mailbox with its body is refused.
  await approve(first, "sx_first");
  const twin = await email("sx_twin", "email_1", "mbx_2");
  await assert.rejects(
    approve(twin, "sx_twin"),
    refusedWith({ gate: "near_duplicate", similarity: 1 }),
  );
  assert.ok(
    (
      await approve(twin, "sx_twin", {
        text: `Ines, a question for Acme: how does your team follow up on warm leads before they go cold?`,
      })
    ).contentHash,
  );
});

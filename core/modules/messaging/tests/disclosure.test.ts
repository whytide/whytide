// approveStepDraftByMode, disclosureLine and approvedContent's disclosureApplied (domain/drafts/
// approve.ts, domain/disclosure/line.ts; README.md "The disclosure line"; gamma-p4-080), each in a
// tenant run as approvals will call them, against the worktree's database, on both channels: the
// line per channel and locale; the frozen row and its hash; the refusals, which change no row; the
// gates on the text and on the text with its line, refused by their names alone; a first email's
// subject; the mailbox's near duplicates, a body the mode approved compared without its line; the
// mode's approval and a person's at once. The lines as messages/en.json holds them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { disclosureLine, withDisclosure } from "../domain/disclosure/line.ts";
import {
  approvedContent,
  approveStepDraft,
  approveStepDraftByMode,
} from "../domain/drafts/approve.ts";
import { checkText } from "../domain/gates/check-text.ts";
import { createMessageDraft, createStepDraft, useMessagingClient } from "../testing/index.ts";
import { COLLEAGUE, GROUNDED, run, seed, seedColleague, sized } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));

const messages: Record<string, string> = JSON.parse(
  readFileSync(new URL("../messages/en.json", import.meta.url), "utf8"),
);
const LINE = {
  linkedin_message: messages["messaging.disclosure.linkedin"] ?? "",
  email: messages["messaging.disclosure.email"] ?? "",
} as const;
/** The most characters a LinkedIn message or an email body may have. */
const LIMIT = 1_900;
/** The longest text the channel's line still fits after: the limit less a blank line and the line. */
const roomOf = (channel: keyof typeof LINE) => LIMIT - "\n\n".length - LINE[channel].length;
const SUBJECT = "Warm leads at Acme";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const emailHash = (body: string, subject: string | null) =>
  sha256(JSON.stringify({ body, subject }));
const refusedBy = (...gates: string[]) => ({ code: "disclosure_check_failed", details: { gates } });

type Columns = Omit<
  Parameters<typeof createStepDraft>[0],
  "workspaceId" | "personId" | "stepExecutionId"
>;

/** The fixture lead and its step drafts' commands: a LinkedIn follow-up unless the columns say. */
async function seeded() {
  const { workspaceId, personId } = await seed();
  const step = (stepExecutionId: string, columns: Columns = {}) =>
    createStepDraft({
      ...{ workspaceId, personId, stepExecutionId },
      ...{ stepKey: "follow_up_1", text: GROUNDED, ...columns },
    });
  /** An email from a mailbox of its own: a first one with SUBJECT unless the columns say. */
  const email = (stepExecutionId: string, stepKey: "email_1" | "email_2", columns: Columns = {}) =>
    step(stepExecutionId, {
      ...{ stepKey, mailboxId: `mbx_${stepExecutionId}` },
      ...(stepKey === "email_1" && { subject: SUBJECT }),
      ...columns,
    });
  const byMode = (draftId: string, stepExecutionId: string) =>
    run(workspaceId, () => approveStepDraftByMode(draftId, { stepExecutionId }));
  const byPerson = (draftId: string, stepExecutionId: string, input: object = {}) =>
    run(workspaceId, () => approveStepDraft(draftId, { stepExecutionId, ...input }));
  const content = (id: string) => run(workspaceId, () => approvedContent(id));
  const row = (id: string) =>
    run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));
  const rows = () => run(workspaceId, (tx) => tx.messageDraft.findMany({ orderBy: { id: "asc" } }));
  return { workspaceId, personId, step, email, byMode, byPerson, content, row, rows };
}

test("disclosureLine: each channel's line as the message file holds it, trimmed, in any locale that falls back to English; withDisclosure puts it after a blank line; a note or any other channel is messaging_input_invalid, a tag that is no locale invalid_locale", () => {
  assert.notEqual(LINE.linkedin_message, LINE.email);
  for (const channel of ["linkedin_message", "email"] as const) {
    assert.ok(LINE[channel].length > 0 && LINE[channel] === LINE[channel].trim(), channel);
    for (const locale of ["en", "EN", "en-GB", "fr"]) {
      assert.equal(disclosureLine(channel, locale), LINE[channel], `${channel} ${locale}`);
    }
    assert.equal(withDisclosure("Ines, hello.", channel, "en"), `Ines, hello.\n\n${LINE[channel]}`);
  }
  for (const channel of ["linkedin_note", "sms", ""]) {
    assert.throws(
      () => disclosureLine(channel as "email", "en"),
      { code: "messaging_input_invalid", details: { fields: ["channel"] } },
      channel,
    );
  }
  assert.throws(() => disclosureLine("email", "not a locale"), { code: "invalid_locale" });
});

test("the mode's approval of a LinkedIn follow-up: the writer's text stays in text, its trim, a blank line and the line freeze in edited_text, approved now, no person's edit, disclosure_applied; it answers the frozen text's hash alone; a second approval is draft_not_ready by the mode and draft_not_editable by a person, and changes nothing", async () => {
  const { step, byMode, byPerson, content, row } = await seeded();
  const written = `  ${GROUNDED}\n`;
  const id = await step("sx_message", { text: written });
  const frozen = `${GROUNDED}\n\n${LINE.linkedin_message}`;
  assert.deepEqual(await byMode(id, "sx_message"), { contentHash: sha256(frozen) });
  const stored = await row(id);
  assert.deepEqual(
    [stored.status, stored.text, stored.editedText, stored.subject, stored.editedSubject],
    ["approved", written, frozen, null, null],
  );
  assert.deepEqual(
    [stored.editedByUser, Number(stored.editRatio), stored.disclosureApplied],
    [false, 0, true],
  );
  assert.ok(stored.approvedAt instanceof Date && stored.editedAt instanceof Date);
  assert.deepEqual(await content(id), {
    text: frozen,
    contentHash: sha256(frozen),
    disclosureApplied: true,
  });

  await assert.rejects(byMode(id, "sx_message"), { code: "draft_not_ready" });
  await assert.rejects(byPerson(id, "sx_message"), { code: "draft_not_editable" });
  await assert.rejects(byPerson(id, "sx_message", { text: GROUNDED }), {
    code: "draft_not_editable",
  });
  assert.deepEqual(await row(id), stored);
});

test("the refusals change no row: a flagged, failed, edited, drafting or approved draft, a text left empty and a connection request's note are draft_not_ready on both channels; a lead's draft or another step's draft_step_mismatch; an unknown id, an empty one or another workspace's draft_not_found; an input off its shape messaging_input_invalid", async () => {
  const { workspaceId, personId, step, email, byMode, rows } = await seeded();
  const linkedin = [
    ["sx_flagged", { status: "flagged" }],
    ["sx_failed", { status: "failed", text: null }],
    ["sx_edited", { status: "edited", editedText: GROUNDED }],
    ["sx_drafting", { status: "drafting", text: null }],
    ["sx_approved", { status: "approved" }],
    ["sx_blank", { text: " \n " }],
    ["sx_note", { stepKey: "connect", text: "" }],
    ["sx_noted", { stepKey: "connect", text: "Ines, a question about warm leads?" }],
  ] as const;
  const emails = [
    ["sx_mail_flagged", "email_2", { status: "flagged" }],
    ["sx_mail_failed", "email_1", { status: "failed", text: null, subject: null }],
    ["sx_mail_edited", "email_2", { status: "edited", editedText: GROUNDED }],
    ["sx_mail_drafting", "email_1", { status: "drafting", text: null, subject: null }],
    ["sx_mail_approved", "email_2", { status: "approved" }],
  ] as const;
  const notReady: [string, string][] = [];
  for (const [sx, columns] of linkedin) notReady.push([await step(sx, columns), sx]);
  for (const [sx, key, columns] of emails) notReady.push([await email(sx, key, columns), sx]);
  const lead = await createMessageDraft({
    ...{ workspaceId, personId, channel: "linkedin_message", text: GROUNDED },
  });
  const ready = await step("sx_ready");
  const theirs = await createStepDraft({
    ...{ workspaceId: "wsp_other", personId, stepExecutionId: "sx_theirs" },
    ...{ stepKey: "follow_up_1", text: GROUNDED },
  });
  const before = await rows();

  for (const [id, sx] of notReady) {
    await assert.rejects(byMode(id, sx), { code: "draft_not_ready" }, sx);
  }
  await assert.rejects(byMode(lead, "sx_ready"), { code: "draft_step_mismatch" });
  await assert.rejects(byMode(ready, "sx_other"), { code: "draft_step_mismatch" });
  for (const id of ["mdr_none", "", theirs]) {
    await assert.rejects(byMode(id, "sx_theirs"), { code: "draft_not_found" }, id);
  }
  await assert.rejects(byMode(ready, ""), {
    code: "messaging_input_invalid",
    details: { fields: ["stepExecutionId"] },
  });
  const typed = { stepExecutionId: "sx_ready", text: GROUNDED } as { stepExecutionId: string };
  await assert.rejects(
    run(workspaceId, () => approveStepDraftByMode(ready, typed)),
    { code: "messaging_input_invalid" },
  );

  assert.deepEqual(await rows(), before);
  const [other] = await run("wsp_other", (tx) => tx.messageDraft.findMany());
  assert.deepEqual(
    [other?.status, other?.editedText, other?.disclosureApplied],
    ["ready", null, false],
  );
});

test("the gates run on the text alone and with its line, and refuse by their names only, in the gates' order: a placeholder and the length its line takes it over; a colleague imported after the text was written, whose name the refusal never carries; the draft stays ready", async () => {
  const { workspaceId, personId, step, byMode, row } = await seeded();
  const prefix = "Hi {{first_name}}, ";
  const both = await step("sx_both", {
    text: `${prefix}${sized(roomOf("linkedin_message") + 1 - prefix.length)}`,
  });
  await assert.rejects(byMode(both, "sx_both"), refusedBy("placeholders", "length"));

  const name = `${COLLEAGUE.firstName} ${COLLEAGUE.lastName}`;
  const text = `${GROUNDED} So did ${name}.`;
  const named = await step("sx_named", { text });
  const target = { personId, channel: "linkedin_message", kind: "outbound_step" } as const;
  const written = await run(workspaceId, () =>
    checkText(text, { ...target, stepKind: "follow_up" }),
  );
  assert.deepEqual(written, { ok: true });
  await seedColleague(workspaceId, personId);
  await assert.rejects(byMode(named, "sx_named"), (error: Error) => {
    assert.deepEqual(
      { code: (error as { code?: string }).code, details: (error as { details?: object }).details },
      refusedBy("colleague_signal"),
    );
    const said = `${error.message} ${JSON.stringify(error)}`;
    assert.ok(!said.includes(COLLEAGUE.lastName) && !said.includes(GROUNDED), said);
    return true;
  });
  for (const id of [both, named]) {
    const kept = await row(id);
    assert.deepEqual(
      [kept.status, kept.editedText, kept.approvedAt, kept.disclosureApplied],
      ["ready", null, null, false],
      id,
    );
  }
});

test("a first email: its subject, trimmed, frozen with the body and its line under the hash of { body, subject }, edited_subject only when the trim changed it; approvedContent answers both and disclosureApplied; one the line takes over the limit, or one without a subject, is refused by the gate's name; one the line takes to the limit exactly is approved", async () => {
  const { email, byMode, content, row } = await seeded();
  const frozen = `${GROUNDED}\n\n${LINE.email}`;
  const own = await email("sx_own", "email_1");
  assert.deepEqual(await byMode(own, "sx_own"), { contentHash: emailHash(frozen, SUBJECT) });
  assert.deepEqual(await content(own), {
    text: frozen,
    subject: SUBJECT,
    contentHash: emailHash(frozen, SUBJECT),
    disclosureApplied: true,
  });
  const kept = await row(own);
  assert.deepEqual(
    [kept.subject, kept.editedSubject, kept.editedByUser, kept.disclosureApplied],
    [SUBJECT, null, false, true],
  );

  const padded = await email("sx_padded", "email_1", { subject: `  ${SUBJECT} ` });
  assert.deepEqual(await byMode(padded, "sx_padded"), { contentHash: emailHash(frozen, SUBJECT) });
  const trimmed = await row(padded);
  assert.deepEqual([trimmed.subject, trimmed.editedSubject], [`  ${SUBJECT} `, SUBJECT]);
  assert.equal((await content(padded))?.subject, SUBJECT);

  const room = roomOf("email");
  const over = await email("sx_over", "email_1", { text: sized(room + 1) });
  await assert.rejects(byMode(over, "sx_over"), refusedBy("length"));
  const untitled = await email("sx_untitled", "email_1", { subject: null });
  await assert.rejects(byMode(untitled, "sx_untitled"), refusedBy("subject"));
  for (const id of [over, untitled]) {
    assert.deepEqual([(await row(id)).status, await content(id)], ["ready", null], id);
  }
  const fits = await email("sx_fits", "email_1", { text: sized(room) });
  await byMode(fits, "sx_fits");
  const sent = await content(fits);
  assert.deepEqual(
    [sent?.text.length, sent?.subject, sent?.disclosureApplied],
    [LIMIT, SUBJECT, true],
  );
});

test("near duplicates of a mailbox: the mode refuses a body another draft of the mailbox holds, near_duplicate by name; a body the mode approved counts as its writer's text, without its line, so the same body after it is refused at a person's approval as at the mode's", async () => {
  const { step, byMode, byPerson, row } = await seeded();
  const follow = (sx: string, mailboxId: string) => step(sx, { stepKey: "email_2", mailboxId });
  const first = await follow("sx_a", "mbx_pair");
  const second = await follow("sx_b", "mbx_pair");
  await assert.rejects(byMode(first, "sx_a"), refusedBy("near_duplicate"));
  await assert.rejects(byMode(second, "sx_b"), refusedBy("near_duplicate"));

  const sent = await follow("sx_sent", "mbx_sent");
  await byMode(sent, "sx_sent");
  assert.equal((await row(sent)).editedText, `${GROUNDED}\n\n${LINE.email}`);
  const twin = await follow("sx_twin", "mbx_sent");
  await assert.rejects(byPerson(twin, "sx_twin"), {
    code: "draft_text_refused",
    details: { issues: [{ gate: "near_duplicate", similarity: 1 }] },
  });
  await assert.rejects(byMode(twin, "sx_twin"), refusedBy("near_duplicate"));
  for (const id of [first, second, twin]) assert.equal((await row(id)).status, "ready", id);
});

test("the mode's approval and a person's at once: one wins and the other is refused, draft_not_editable for the person, draft_not_ready for the mode; the frozen text ends with the line exactly when disclosureApplied says the mode won", async () => {
  const { step, byMode, byPerson, content } = await seeded();
  for (const sx of ["sx_race_1", "sx_race_2", "sx_race_3", "sx_race_4"]) {
    const id = await step(sx);
    const [mode, person] = await Promise.allSettled([byMode(id, sx), byPerson(id, sx)]);
    const frozen = await content(id);
    const won = frozen?.disclosureApplied === true;
    assert.deepEqual(
      [mode.status, person.status],
      won ? ["fulfilled", "rejected"] : ["rejected", "fulfilled"],
      sx,
    );
    const lost = (won ? person : mode) as PromiseRejectedResult;
    const code = (lost.reason as { code?: string }).code;
    assert.equal(code, won ? "draft_not_editable" : "draft_not_ready", sx);
    const text = won ? `${GROUNDED}\n\n${LINE.linkedin_message}` : GROUNDED;
    assert.deepEqual([frozen?.text, frozen?.contentHash], [text, sha256(text)], sx);
  }
});

// Safety case, send path (gamma-p4-080; docs/security.md "The AI disclosure line"; gamma's rules we
// keep: "Any AI message sent without per-message approval carries the AI disclosure line"): no draft
// is approved by the campaign's mode without its channel's line closing the frozen text, under the
// hash the send compares, and the mode takes no text from its caller; a person's approval never adds
// the line; a text the line would take over its channel's length is refused and stays `ready`, for a
// person. Both channels, against the worktree's database; the lines as the message file holds them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import {
  approvedContent,
  approveStepDraft,
  approveStepDraftByMode,
} from "../../domain/drafts/approve.ts";
import { createStepDraft, useMessagingClient } from "../../testing/index.ts";
import { GROUNDED, run, seed, sized } from "../fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));

/** The lines as messages/en.json holds them: the oracle, whatever counsel's text becomes. */
const messages: Record<string, string> = JSON.parse(
  readFileSync(new URL("../../messages/en.json", import.meta.url), "utf8"),
);
const LINE = {
  linkedin_message: messages["messaging.disclosure.linkedin"] ?? "",
  email: messages["messaging.disclosure.email"] ?? "",
} as const;
type Channel = keyof typeof LINE;
/** The most characters a LinkedIn message or a typed email body may have. */
const LIMIT = 1_900;
const SUBJECT = "Warm leads at Acme";
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** What the send compares: a LinkedIn text's hash, an email's of `{ body, subject }`. */
const hashOf = (channel: Channel, body: string, subject: string | null) =>
  sha256(channel === "email" ? JSON.stringify({ body, subject }) : body);

type StepKey = "follow_up_1" | "email_1" | "email_2";

/** The fixture lead and its step drafts' commands, each email from a mailbox of its own. */
async function seeded() {
  const { workspaceId, personId } = await seed();
  const step = (stepExecutionId: string, stepKey: StepKey, columns: object = {}) =>
    createStepDraft({
      ...{ workspaceId, personId, stepExecutionId, stepKey, mailboxId: `mbx_${stepExecutionId}` },
      ...{ text: GROUNDED, ...(stepKey === "email_1" && { subject: SUBJECT }), ...columns },
    });
  const byMode = (draftId: string, stepExecutionId: string, extra: object = {}) =>
    run(workspaceId, () =>
      approveStepDraftByMode(draftId, { stepExecutionId, ...extra } as { stepExecutionId: string }),
    );
  const byPerson = (draftId: string, stepExecutionId: string, input: object = {}) =>
    run(workspaceId, () => approveStepDraft(draftId, { stepExecutionId, ...input }));
  const content = (id: string) => run(workspaceId, () => approvedContent(id));
  const row = (id: string) =>
    run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));
  const rows = () => run(workspaceId, (tx) => tx.messageDraft.findMany());
  return { step, byMode, byPerson, content, row, rows };
}

test("no draft is approved by the mode without its channel's line: a LinkedIn follow-up, a follow-up email and a first email each freeze the writer's text, a blank line and the line, under the hash the send compares; the mode takes no text or subject from its caller; every draft it approved ends with its line", async () => {
  const { step, byMode, content, rows } = await seeded();
  const cases = [
    ["sx_message", "follow_up_1", "linkedin_message", null],
    ["sx_later", "email_2", "email", null],
    ["sx_first", "email_1", "email", SUBJECT],
  ] as const;
  for (const [stepExecutionId, stepKey, channel, subject] of cases) {
    const id = await step(stepExecutionId, stepKey);
    for (const words of [{ text: GROUNDED }, { subject: SUBJECT }, { text: "" }]) {
      await assert.rejects(byMode(id, stepExecutionId, words), {
        code: "messaging_input_invalid",
      });
    }
    assert.equal(await content(id), null, stepExecutionId);
    const frozen = `${GROUNDED}\n\n${LINE[channel]}`;
    const { contentHash } = await byMode(id, stepExecutionId);
    assert.equal(contentHash, hashOf(channel, frozen, subject), stepExecutionId);
    assert.notEqual(contentHash, hashOf(channel, GROUNDED, subject), stepExecutionId);
    const answer = await content(id);
    assert.deepEqual(
      [answer?.text, answer?.contentHash, answer?.disclosureApplied],
      [frozen, contentHash, true],
      stepExecutionId,
    );
    if (channel === "email") assert.equal(answer?.subject, subject, stepExecutionId);
  }
  const approved = (await rows()).filter((draft) => draft.status === "approved");
  assert.equal(approved.length, cases.length);
  for (const draft of approved) {
    const line = LINE[draft.channel as Channel];
    assert.ok(line.length > 0, draft.channel);
    assert.ok(draft.editedText?.endsWith(`\n\n${line}`), draft.id);
    assert.deepEqual([draft.disclosureApplied, draft.editedByUser], [true, false], draft.id);
  }
});

test("a person's approval never adds the line: a LinkedIn message and both emails a person approves, as written or typed, freeze the person's text alone, and approvedContent answers disclosureApplied false; a text the mode left to a person too", async () => {
  const { step, byMode, byPerson, content, rows } = await seeded();
  const typed = `${GROUNDED} Thanks!`;
  const cases = [
    ["sx_message", "follow_up_1", {}, GROUNDED],
    ["sx_typed", "follow_up_1", { text: typed }, typed],
    ["sx_later", "email_2", {}, GROUNDED],
    ["sx_first", "email_1", { subject: "Warm leads, sooner" }, GROUNDED],
  ] as const;
  for (const [stepExecutionId, stepKey, input, text] of cases) {
    const id = await step(stepExecutionId, stepKey);
    await byPerson(id, stepExecutionId, input);
    const answer = await content(id);
    assert.deepEqual([answer?.text, answer?.disclosureApplied], [text, false], stepExecutionId);
  }

  const room = LIMIT - "\n\n".length - LINE.linkedin_message.length;
  const long = sized(room + 1);
  const left = await step("sx_left", "follow_up_1", { text: long });
  await assert.rejects(byMode(left, "sx_left"), { code: "disclosure_check_failed" });
  await byPerson(left, "sx_left");
  assert.deepEqual(await content(left), {
    text: long,
    contentHash: sha256(long),
    disclosureApplied: false,
  });

  const drafts = await rows();
  assert.equal(drafts.length, cases.length + 1);
  for (const draft of drafts) {
    const frozen = draft.editedText ?? draft.text ?? "";
    const lines = [LINE.linkedin_message, LINE.email].filter((line) => frozen.includes(line));
    assert.deepEqual([draft.status, draft.disclosureApplied, lines], ["approved", false, []]);
  }
});

test("the length: a text its line takes over the channel's limit is refused, disclosure_check_failed with the length gate, and stays ready, unapproved and without the line, on LinkedIn and email; one its line takes to the limit exactly is approved", async () => {
  const { step, byMode, content, row } = await seeded();
  const cases = [
    ["follow_up_1", "linkedin_message"],
    ["email_2", "email"],
  ] as const;
  for (const [stepKey, channel] of cases) {
    // The longest text that takes the line: the limit less the blank line and the line.
    const room = LIMIT - "\n\n".length - LINE[channel].length;
    const over = await step(`sx_over_${stepKey}`, stepKey, { text: sized(room + 1) });
    await assert.rejects(byMode(over, `sx_over_${stepKey}`), {
      code: "disclosure_check_failed",
      details: { gates: ["length"] },
    });
    const kept = await row(over);
    assert.deepEqual(
      [kept.status, kept.text, kept.editedText, kept.approvedAt, kept.disclosureApplied],
      ["ready", sized(room + 1), null, null, false],
      channel,
    );
    assert.equal(await content(over), null, channel);

    const fits = await step(`sx_fits_${stepKey}`, stepKey, { text: sized(room) });
    await byMode(fits, `sx_fits_${stepKey}`);
    const frozen = await content(fits);
    assert.deepEqual([frozen?.text.length, frozen?.disclosureApplied], [LIMIT, true], channel);
  }
});

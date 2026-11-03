// Safety case, send path (beta-p3-010; docs/security.md "A sequence step's draft"): a sequence
// step's draft that failed, or that the sweep found stuck, never carries a text approvals could send;
// a connection request's note calls no model; and a follow-up's model input never holds another
// person's draft, of this workspace or another. On the LLM fake, against the worktree's database.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { requestStepDraft } from "../../domain/drafts/step.ts";
import { markFailed } from "../../domain/drafts/store.ts";
import { sweepStuckDrafts } from "../../domain/drafts/sweep.ts";
import { writeDraft } from "../../domain/drafts/write.ts";
import { createStepDraft, useMessagingClient } from "../../testing/index.ts";
import { contextOf, fake, GROUNDED, PLAN, run, seed, sized, stored } from "../fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));
beforeEach(() => fake.reset());

const MINUTE = 60_000;
/** A text a failed draft must lose: what a writer or a member could have left in it. */
const LEFTOVER = "Ines, a text that must never be sent from a failed draft.";

async function seeded() {
  const { workspaceId, personId, userId } = await seed();
  const request = (
    stepExecutionId: string,
    stepKey: "connect" | "message_1" | "follow_up_1" | "follow_up_2",
    earlierDraftIds: string[] = [],
  ) =>
    run(workspaceId, () =>
      requestStepDraft({
        personId,
        stepExecutionId,
        stepKey,
        senderUserId: userId,
        earlierDraftIds,
      }),
    );
  return { workspaceId, personId, userId, request };
}

test("a step's draft that fails or is stuck carries no text: ai_failed from either call, a sender no longer a member, earlier_draft_invalid, the workflow's failure mark and the sweep; each publishes `failed`", async () => {
  const { workspaceId, personId, userId, request } = await seeded();
  const context = contextOf(workspaceId);
  const ended: string[] = [];
  const failedWith = async (draftId: string, code: string) => {
    const draft = await stored(workspaceId, draftId);
    assert.deepEqual([draft.status, draft.text, draft.flagReasons], ["failed", null, [{ code }]]);
    ended.push(draftId);
  };

  const plan = await request("sx_plan", "message_1");
  fake.script("no plan", "no plan");
  await writeDraft({ draftId: plan.draftId, userId }, context);
  await failedWith(plan.draftId, "ai_failed");

  const write = await request("sx_write", "follow_up_1");
  fake.script(PLAN, "no text", "no text");
  await writeDraft({ draftId: write.draftId, userId }, context);
  await failedWith(write.draftId, "ai_failed");

  const outsider = await createUser();
  const left = await request("sx_left", "follow_up_2");
  await writeDraft({ draftId: left.draftId, userId: outsider.id }, context);
  await failedWith(left.draftId, "draft_requester_not_member");

  const invalid = await request("sx_invalid", "follow_up_2", ["mdr_none"]);
  await writeDraft({ draftId: invalid.draftId, userId, earlierDraftIds: ["mdr_none"] }, context);
  await failedWith(invalid.draftId, "earlier_draft_invalid");

  // A `drafting` row holding a text, as no writer leaves one: the mark and the sweep clear it.
  const drafting = { workspaceId, personId, status: "drafting" as const, text: LEFTOVER };
  const marked = await createStepDraft({ ...drafting, stepExecutionId: "sx_marked" });
  await run(workspaceId, () => markFailed(marked));
  await failedWith(marked, "write_failed");
  const createdAt = new Date(Date.now() - 31 * MINUTE);
  const stuck = await createStepDraft({ ...drafting, stepExecutionId: "sx_stuck", createdAt });
  assert.deepEqual(await run(workspaceId, () => sweepStuckDrafts()), { stuck: 1 });
  await failedWith(stuck, "draft_stuck");

  const events = await run(workspaceId, (tx) =>
    tx.outboxEntry.findMany({ where: { eventName: "messaging.step_draft_ready" } }),
  );
  const payloads = events.map(({ payload }) => payload as { draftId: string; status: string });
  assert.deepEqual(payloads.map(({ draftId }) => draftId).sort(), ended.sort());
  assert.ok(payloads.every((payload) => payload.status === "failed"));
  assert.ok(!JSON.stringify(payloads).includes(LEFTOVER));
});

test("connect makes no model call: its note is `ready` and empty at once, with no decision record and no cost event", async () => {
  const { workspaceId, request } = await seeded();
  const { draftId } = await request("sx_connect", "connect");
  const draft = await stored(workspaceId, draftId);
  assert.deepEqual([draft.status, draft.text, draft.decisionRecordId], ["ready", "", null]);
  assert.equal(fake.recordedCalls.length, 0);
  const records = await run(workspaceId, (tx) => tx.decisionRecord.count());
  const costs = await run(workspaceId, (tx) => tx.costEvent.count());
  assert.deepEqual({ records, costs }, { records: 0, costs: 0 });
});

test("another person's draft never enters a follow-up's input: one of another person, or of another workspace, fails the draft before any model call; with the person's own, no other text reaches the model", async () => {
  const { workspaceId, personId, userId, request } = await seeded();
  const elsewhere = await seed();
  const approved = { status: "approved" as const, stepKey: "message_1" as const };
  const theirs = "Ines, a message to another person that must never reach this writer.";
  const otherPerson = await createStepDraft({
    ...approved,
    workspaceId,
    personId: "per_other",
    stepExecutionId: "sx_other_person",
    text: theirs,
  });
  const otherWorkspace = await createStepDraft({
    ...approved,
    workspaceId: elsewhere.workspaceId,
    personId: elsewhere.personId,
    stepExecutionId: "sx_other_workspace",
    text: theirs,
  });
  const own = await createStepDraft({
    ...approved,
    workspaceId,
    personId,
    stepExecutionId: "sx_own",
    text: GROUNDED,
  });
  const context = contextOf(workspaceId);
  for (const [index, earlierDraftIds] of [[otherPerson], [own, otherWorkspace]].entries()) {
    const { draftId } = await request(`sx_${index}`, "follow_up_1", earlierDraftIds);
    assert.deepEqual(await writeDraft({ draftId, userId, earlierDraftIds }, context), {
      status: "failed",
    });
    const draft = await stored(workspaceId, draftId);
    assert.deepEqual([draft.text, draft.flagReasons], [null, [{ code: "earlier_draft_invalid" }]]);
  }
  assert.equal(fake.recordedCalls.length, 0);

  const { draftId } = await request("sx_own_follow_up", "follow_up_1", [own]);
  fake.script(PLAN, { text: sized(180) });
  await writeDraft({ draftId, userId, earlierDraftIds: [own] }, context);
  const sent = JSON.stringify(fake.recordedCalls);
  assert.equal(fake.recordedCalls.length, 2);
  assert.ok(sent.includes(GROUNDED), "the person's own earlier text reaches the model");
  assert.ok(!sent.includes(theirs), "another person's text reached the model");
});

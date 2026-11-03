// A sequence step's draft (README.md "The writer", docs/flows.md; beta-p3-010): requestStepDraft
// for each step key, one draft per step execution in the code and in SQL, the table's CHECKs, the
// earlier drafts the writer reads, its last write while the draft is `drafting` only, the sweep, and
// messaging.step_draft_ready on each end. On the LLM fake, against the worktree's database; the
// workflow end to end is the worker's test, the failures without text the safety suite's.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setTimeout } from "node:timers/promises";
import type { Prisma } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { newId } from "@whytide/platform";
import { useTenancyClient } from "@whytide/tenancy/testing";
import type { StepKey } from "../domain/drafts/constants.ts";
import { requestStepDraft } from "../domain/drafts/step.ts";
import { markFailed } from "../domain/drafts/store.ts";
import { sweepStuckDrafts } from "../domain/drafts/sweep.ts";
import { writeDraft } from "../domain/drafts/write.ts";
import { createMessageDraft, createStepDraft, useMessagingClient } from "../testing/index.ts";
import { contextOf, draftOf, fake, GROUNDED, PLAN, run, seed, stored } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));
beforeEach(() => {
  fake.reset();
  fake.state.delayMs = 0;
});

const READY = "messaging.step_draft_ready";
const REQUESTED = "messaging.draft_requested";
const MINUTE = 60_000;
/** The payloads of one event in the workspace's outbox, by draft id. */
const published = (workspaceId: string, eventName: string) =>
  run(workspaceId, async (tx) =>
    (await tx.outboxEntry.findMany({ where: { eventName } })).map((entry) => entry.payload),
  ).then(sorted);
const sorted = <T>(payloads: T[]) => {
  const draftId = (payload: T) => (payload as { draftId: string }).draftId;
  return payloads.sort((a, b) => draftId(a).localeCompare(draftId(b)));
};
const row = (workspaceId: string, id: string) =>
  run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow({ where: { id } }));

/** A workspace with its lead, and the request of a step of its sequence for the Member. */
async function seeded() {
  const { workspaceId, personId, userId } = await seed();
  // Any key, so that a test can send one of no step.
  const request = (stepExecutionId: string, stepKey: string, earlierDraftIds: string[] = []) =>
    run(workspaceId, () =>
      requestStepDraft({
        personId,
        stepExecutionId,
        stepKey: stepKey as StepKey,
        senderUserId: userId,
        earlierDraftIds,
      }),
    );
  const write = (draftId: string, earlierDraftIds: string[] = []) =>
    writeDraft({ draftId, userId, earlierDraftIds }, contextOf(workspaceId));
  return { workspaceId, personId, userId, request, write };
}

test("each step key: connect an empty note `ready` at once with its step_draft_ready; message_1, follow_up_1 and follow_up_2 a `drafting` message and draft_requested as the sender's owner, with the earlier ids", async () => {
  const { workspaceId, personId, userId, request } = await seeded();
  const steps = [
    ["connect", "linkedin_note", "ready", "", []],
    ["message_1", "linkedin_message", "drafting", null, []],
    ["follow_up_1", "linkedin_message", "drafting", null, ["mdr_first"]],
    ["follow_up_2", "linkedin_message", "drafting", null, ["mdr_first", "mdr_second"]],
  ] as const;
  const requested: object[] = [];
  for (const [stepKey, channel, status, text, earlierDraftIds] of steps) {
    const stepExecutionId = `sx_${stepKey}`;
    const { draftId } = await request(stepExecutionId, stepKey, [...earlierDraftIds]);
    const draft = await row(workspaceId, draftId);
    assert.deepEqual(
      {
        kind: draft.kind,
        step: [draft.stepExecutionId, draft.stepKey],
        channel: draft.channel,
        status: draft.status,
        text: draft.text,
        approval: [draft.approvedAt, draft.editedByUser, draft.editRatio],
      },
      {
        kind: "outbound_step",
        step: [stepExecutionId, stepKey],
        channel,
        status,
        text,
        approval: [null, false, null],
      },
      stepKey,
    );
    if (stepKey === "connect") {
      assert.deepEqual(await published(workspaceId, READY), [
        { draftId, stepExecutionId, status: "ready" },
      ]);
    } else {
      requested.push({ workspaceId, draftId, personId, userId, earlierDraftIds });
    }
  }
  assert.deepEqual(await published(workspaceId, REQUESTED), sorted(requested));
  assert.equal((await published(workspaceId, READY)).length, 1);
  assert.equal(fake.recordedCalls.length, 0);
});

test("an unknown step key or more than three earlier ids is messaging_input_invalid, a person without a lead dossier_lead_not_found: nothing written, nothing published", async () => {
  const { workspaceId, request } = await seeded();
  const invalid = (fields: string[]) => ({ code: "messaging_input_invalid", details: { fields } });
  await assert.rejects(request("sx_1", "follow_up_3"), invalid(["stepKey"]));
  await assert.rejects(
    request("sx_1", "follow_up_1", ["a", "b", "c", "d"]),
    invalid(["earlierDraftIds"]),
  );
  const gone = { personId: "per_gone", stepExecutionId: "sx_1", senderUserId: "usr_any" };
  await assert.rejects(
    run(workspaceId, () => requestStepDraft({ ...gone, stepKey: "connect" })),
    { code: "dossier_lead_not_found" },
  );
  assert.equal(await run(workspaceId, (tx) => tx.messageDraft.count()), 0);
  assert.equal(await run(workspaceId, (tx) => tx.outboxEntry.count()), 0);
});

test("one draft per step execution: a second request answers the first and creates none; the partial key refuses a second row in SQL, in this workspace only; the CHECKs tie the step's columns to its kind and approved_at to `approved`", async () => {
  const { workspaceId, personId, request } = await seeded();
  const first = await request("sx_1", "message_1");
  assert.deepEqual(await request("sx_1", "message_1"), first);
  assert.deepEqual(await request("sx_1", "follow_up_1", ["mdr_any"]), first);
  assert.equal(await run(workspaceId, (tx) => tx.messageDraft.count()), 1);
  assert.equal((await published(workspaceId, REQUESTED)).length, 1);

  const refusedBy = (constraint: string) => (error: unknown) =>
    `${String(error)} ${JSON.stringify(error)}`.includes(constraint);
  const step = { workspaceId, personId, stepExecutionId: "sx_1" };
  await assert.rejects(
    createStepDraft(step),
    refusedBy("message_drafts_workspace_id_step_execution_id_key"),
  );
  await createStepDraft({ ...step, workspaceId: "wsp_other" });
  await createMessageDraft({ workspaceId, personId });
  await createMessageDraft({ workspaceId, personId });

  const app = asRole("app");
  const insert = (data: Partial<Prisma.MessageDraftUncheckedCreateInput>) =>
    app.messageDraft.create({
      data: {
        id: newId("mdr"),
        workspaceId,
        personId,
        channel: "linkedin_message",
        ...data,
      },
    });
  const outbound = {
    kind: "outbound_step",
    stepExecutionId: "sx_2",
    stepKey: "message_1",
  } as const;
  const refused = [
    [{ stepExecutionId: "sx_2", stepKey: "message_1" }, "message_drafts_step_columns"],
    [{ kind: "outbound_step", stepKey: "message_1" }, "message_drafts_step_columns"],
    [{ kind: "outbound_step", stepExecutionId: "sx_2" }, "message_drafts_step_columns"],
    [{ ...outbound, status: "approved" }, "message_drafts_approved_at"],
    [{ ...outbound, approvedAt: new Date() }, "message_drafts_approved_at"],
    [{ status: "approved", approvedAt: new Date() }, "message_drafts_approved_step"],
    [{ ...outbound, editRatio: 1.5 }, "message_drafts_edit_ratio_share"],
    [{ ...outbound, editRatio: -0.1 }, "message_drafts_edit_ratio_share"],
  ] as const;
  for (const [data, constraint] of refused) {
    await assert.rejects(insert(data), refusedBy(constraint), constraint);
  }
  await insert({ ...outbound, status: "approved", approvedAt: new Date(), editRatio: 0.25 });
});

test("a follow-up reads the person's approved step drafts it names; another person's, one not approved, a lead's draft or an unknown id fails it with earlier_draft_invalid, no text and no model call", async () => {
  const { workspaceId, personId, request, write } = await seeded();
  const base = { workspaceId, personId, status: "approved" as const, text: GROUNDED };
  const own = await createStepDraft({ ...base, stepExecutionId: "sx_own" });
  const others = await createStepDraft({ ...base, personId: "per_other", stepExecutionId: "sx_o" });
  const unapproved = await createStepDraft({
    ...base,
    status: "ready",
    stepExecutionId: "sx_ready",
  });
  const lead = await createMessageDraft({ workspaceId, personId, text: GROUNDED });
  const cases = [[others], [own, unapproved], [lead], ["mdr_none"]];
  for (const [index, earlier] of cases.entries()) {
    const { draftId } = await request(`sx_${index}`, "follow_up_1", earlier);
    assert.deepEqual(await write(draftId, earlier), { status: "failed" });
    const draft = await stored(workspaceId, draftId);
    assert.deepEqual(
      [draft.text, draft.flagReasons, draft.decisionRecordId],
      [null, [{ code: "earlier_draft_invalid" }], null],
    );
  }
  assert.equal(fake.recordedCalls.length, 0);

  // The same id twice is one draft: it reaches the block once.
  const { draftId } = await request("sx_twice", "follow_up_1", [own, own]);
  fake.script(PLAN, { text: GROUNDED });
  assert.deepEqual(await write(draftId, [own, own]), { status: "ready" });
  const block = (index: number) =>
    JSON.stringify(fake.recordedCalls[index]?.input).split(GROUNDED).length - 1;
  assert.deepEqual([block(0), block(1)], [1, 1]);
});

test("the last write is the writer's only while the draft is `drafting`: a draft the sweep failed meanwhile stays failed, draft_stuck, with no text, and the late answer is dropped", async () => {
  const { workspaceId, request, write } = await seeded();
  const { draftId } = await request("sx_slow", "message_1");
  fake.script(PLAN, { text: GROUNDED });
  fake.state.delayMs = 300;
  const writing = write(draftId);
  while (fake.recordedCalls.length === 0) await setTimeout(10);
  const later = new Date(Date.now() + 31 * MINUTE);
  assert.deepEqual(await run(workspaceId, () => sweepStuckDrafts(later)), { stuck: 1 });
  assert.deepEqual(await writing, { status: "failed" });
  const draft = await stored(workspaceId, draftId);
  assert.deepEqual(
    [draft.status, draft.text, draft.plan, draft.flagReasons],
    ["failed", null, null, [{ code: "draft_stuck" }]],
  );
  assert.deepEqual(await published(workspaceId, READY), [
    { draftId, stepExecutionId: "sx_slow", status: "failed" },
  ]);
});

test("every step draft that ends publishes one messaging.step_draft_ready, ids and the status only: `ready`, `flagged`, `failed` (earlier_draft_invalid, the workflow's failure mark); a lead's draft none", async () => {
  const { workspaceId, personId, userId, request, write } = await seeded();
  const ready = await request("sx_ready", "message_1");
  fake.script(PLAN, { text: GROUNDED });
  assert.deepEqual(await write(ready.draftId), { status: "ready" });
  const flagged = await request("sx_flagged", "follow_up_1");
  const unknown = { ...PLAN, factIds: ["f_99"] };
  fake.script(unknown, unknown, unknown);
  assert.deepEqual(await write(flagged.draftId), { status: "flagged" });
  const invalid = await request("sx_invalid", "follow_up_2", ["mdr_none"]);
  assert.deepEqual(await write(invalid.draftId, ["mdr_none"]), { status: "failed" });
  const step = { workspaceId, personId, status: "drafting" as const };
  const marked = await createStepDraft({ ...step, stepExecutionId: "sx_marked" });
  await run(workspaceId, () => markFailed(marked));
  const lead = await draftOf(workspaceId, personId, "linkedin_message");
  fake.script(PLAN, { text: GROUNDED });
  await writeDraft({ draftId: lead, userId }, contextOf(workspaceId));
  // A second end never comes: a draft written already answers its status and publishes nothing.
  await run(workspaceId, () => markFailed(ready.draftId));
  assert.deepEqual(await write(ready.draftId), { status: "ready" });

  assert.deepEqual(
    await published(workspaceId, READY),
    sorted([
      { draftId: flagged.draftId, stepExecutionId: "sx_flagged", status: "flagged" },
      { draftId: invalid.draftId, stepExecutionId: "sx_invalid", status: "failed" },
      { draftId: marked, stepExecutionId: "sx_marked", status: "failed" },
      { draftId: ready.draftId, stepExecutionId: "sx_ready", status: "ready" },
    ]),
  );
  assert.equal((await stored(workspaceId, marked)).status, "failed");
});

test("the sweep fails each draft of either kind still `drafting` 30 minutes after it was made, draft_stuck, and publishes a step's event; a younger draft, or one that ended, stays; a second sweep finds none", async () => {
  const { workspaceId, personId } = await seeded();
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * MINUTE);
  const drafting = { workspaceId, personId, status: "drafting" as const };
  const stuck = await createStepDraft({ ...drafting, stepExecutionId: "sx_1", createdAt: ago(31) });
  const lead = await createMessageDraft({ ...drafting, createdAt: ago(45) });
  const young = await createStepDraft({ ...drafting, stepExecutionId: "sx_2", createdAt: ago(29) });
  const ended = await createStepDraft({
    workspaceId,
    personId,
    stepExecutionId: "sx_3",
    text: GROUNDED,
    createdAt: ago(90),
  });
  assert.deepEqual(await run(workspaceId, () => sweepStuckDrafts(now)), { stuck: 2 });
  const statuses = async (...ids: string[]) =>
    Promise.all(ids.map(async (id) => (await stored(workspaceId, id)).status));
  assert.deepEqual(await statuses(stuck, lead, young, ended), [
    "failed",
    "failed",
    "drafting",
    "ready",
  ]);
  for (const id of [stuck, lead]) {
    const { text, flagReasons } = await stored(workspaceId, id);
    assert.deepEqual([text, flagReasons], [null, [{ code: "draft_stuck" }]]);
  }
  assert.deepEqual(await published(workspaceId, READY), [
    { draftId: stuck, stepExecutionId: "sx_1", status: "failed" },
  ]);
  assert.deepEqual(await run(workspaceId, () => sweepStuckDrafts(now)), { stuck: 0 });
  assert.equal((await published(workspaceId, READY)).length, 1);
});

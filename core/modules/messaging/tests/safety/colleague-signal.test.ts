// Safety case, send path (beta-p3-020; docs/security.md "The two layers of colleague privacy"; beta's
// rules we keep: a message never mentions a colleague's signal): no draft reaches `ready`, and none
// is approved, with a text that points at a colleague of the person or names one; and an approved
// draft's text never changes afterwards, whatever path tries. On the LLM fake, against the
// worktree's database.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { approvedContent, approveStepDraft } from "../../domain/drafts/approve.ts";
import { requestStepDraft } from "../../domain/drafts/step.ts";
import { editDraft, markFailed, regenerateDraft } from "../../domain/drafts/store.ts";
import { sweepStuckDrafts } from "../../domain/drafts/sweep.ts";
import { writeDraft } from "../../domain/drafts/write.ts";
import { createStepDraft, useMessagingClient } from "../../testing/index.ts";
import {
  COLLEAGUE,
  COLLEAGUES_TEXT,
  contextOf,
  fake,
  GROUNDED,
  PLAN,
  run,
  seed,
  seedColleague,
  stored,
} from "../fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));
beforeEach(() => fake.reset());

const MINUTE = 60_000;
const NAME = `${COLLEAGUE.firstName} ${COLLEAGUE.lastName}`;
const refused = (phrase: string) => ({
  code: "draft_text_refused",
  details: { issues: [{ gate: "colleague_signal", phrase }] },
});

async function seeded() {
  const { workspaceId, personId, userId } = await seed();
  await seedColleague(workspaceId, personId);
  const request = (stepExecutionId: string, stepKey: "connect" | "message_1") =>
    run(workspaceId, () =>
      requestStepDraft({ personId, stepExecutionId, stepKey, senderUserId: userId }),
    );
  const approve = (draftId: string, stepExecutionId: string, text?: string) =>
    run(workspaceId, () =>
      approveStepDraft(draftId, { stepExecutionId, ...(text !== undefined && { text }) }),
    );
  return { workspaceId, personId, userId, request, approve };
}

test("no text pointing at a colleague is `ready` or approved: the writer's answers that do end the draft flagged; approving it as it is, or with a typed text naming the colleague or a colleague's phrase, is refused and leaves it unapproved", async () => {
  const { workspaceId, userId, request, approve } = await seeded();
  const { draftId } = await request("sx_message", "message_1");
  fake.script(
    PLAN,
    { text: COLLEAGUES_TEXT },
    { text: COLLEAGUES_TEXT },
    { text: COLLEAGUES_TEXT },
  );
  const written = await writeDraft({ draftId, userId }, contextOf(workspaceId));
  assert.deepEqual(written, { status: "flagged" });
  const issue = { gate: "colleague_signal", phrase: "your colleagues" };
  assert.deepEqual((await stored(workspaceId, draftId)).flagReasons, [issue]);

  await assert.rejects(approve(draftId, "sx_message"), refused("your colleagues"));
  const named = `Ines, ${NAME} at Acme saw it too. ${GROUNDED}`;
  await assert.rejects(approve(draftId, "sx_message", named), refused(NAME));
  const phrase = `${GROUNDED} Someone on your team liked it!`;
  await assert.rejects(approve(draftId, "sx_message", phrase), refused("Someone on your team"));

  const { draftId: note } = await request("sx_note", "connect");
  const boss = "Ines, YOUR BOSS liked our post.";
  await assert.rejects(approve(note, "sx_note", boss), refused("YOUR BOSS"));

  const drafts = await run(workspaceId, (tx) => tx.messageDraft.findMany());
  assert.deepEqual(drafts.map(({ status }) => status).sort(), ["flagged", "ready"]);
  assert.ok(drafts.every((draft) => draft.approvedAt === null && draft.editedText === null));
  assert.equal(await run(workspaceId, () => approvedContent(draftId)), null);
});

test("an approved draft's text never changes: a second approval, an edit, a regeneration, the writer, the failure mark and the sweep leave its text, its hash and its status", async () => {
  const { workspaceId, personId, userId, approve } = await seeded();
  const step = { workspaceId, personId, stepExecutionId: "sx_frozen", text: GROUNDED };
  const draftId = await createStepDraft(step);
  const own = `${GROUNDED} Thanks!`;
  const approval = await approve(draftId, "sx_frozen", own);
  const frozen = await run(workspaceId, () => approvedContent(draftId));
  assert.deepEqual(frozen, { text: own, contentHash: approval.contentHash });
  const before = await run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow());

  const notEditable = { code: "draft_not_editable" };
  await assert.rejects(approve(draftId, "sx_frozen", GROUNDED), notEditable);
  await assert.rejects(approve(draftId, "sx_frozen"), notEditable);
  const stepRefused = { code: "step_draft_not_editable" };
  await assert.rejects(
    run(workspaceId, () => editDraft(draftId, { editedText: GROUNDED })),
    stepRefused,
  );
  await assert.rejects(
    run(workspaceId, () => regenerateDraft(draftId)),
    stepRefused,
  );
  const context = contextOf(workspaceId);
  assert.deepEqual(await writeDraft({ draftId, userId }, context), { status: "approved" });
  assert.equal(fake.recordedCalls.length, 0);
  await run(workspaceId, () => markFailed(draftId));
  const later = new Date(Date.now() + 31 * MINUTE);
  assert.deepEqual(await run(workspaceId, () => sweepStuckDrafts(later)), { stuck: 0 });

  const after = await run(workspaceId, (tx) => tx.messageDraft.findFirstOrThrow());
  assert.deepEqual(after, before);
  assert.deepEqual(await run(workspaceId, () => approvedContent(draftId)), frozen);
});

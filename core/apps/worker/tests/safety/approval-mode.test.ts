// Safety cases of the campaign's approval mode at the sender (gamma-p4-070;
// core/modules/campaigns/README.md "The approval mode", "The approval check"), on the LinkedIn fake,
// the slice's Temporal and a schema of its database (fixtures/campaigns-sender.ts). A follow-up the
// mode approved, its text frozen with the AI disclosure line as approvals' approveByMode and
// messaging leave it, is blocked not_approved while its campaign is in review_everything, the lock
// holding whatever the campaign's mode says, and nothing is sent; in review_first_touches, the lock
// over, it goes out with the line, the hash of the text and the line stored with the gate's checks,
// which name the mode, the follow-up and the mode's origin. The gate's cases are campaigns'
// tests/safety/approval-mode.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  afterSend,
  app,
  sender,
  sends,
  sha256,
  stepOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

const commands = new URL(
  "../../../../modules/campaigns/dist/domain/campaigns/commands.js",
  import.meta.url,
);
type Commands = typeof import("../../../../modules/campaigns/dist/domain/campaigns/commands.js");
const { seedCampaign }: Commands = await import(commands.href);

useSenderTests();
const TEXT = "Noor, how does your team review its pipeline each week?";
/** messaging's LinkedIn line, after a blank line (its messages/en.json). */
const FROZEN = `${TEXT}\n\nWritten with AI assistance and sent without a person's review.`;

/** The step's approval made the mode's, as approveByMode and messaging's freeze leave it. */
async function approvedByMode(id: string): Promise<void> {
  const { draftId, approvalItemId } = await stepOf(id);
  const draft = { editedText: FROZEN, disclosureApplied: true };
  await app.messageDraft.update({ where: { id: draftId ?? "" }, data: draft });
  await app.approvalItem.update({
    where: { id: approvalItemId ?? "" },
    data: {
      ...{ approvalBy: "mode", decisionOrigin: "approval_mode", decidedBy: null },
      approvedContentHash: sha256(FROZEN),
    },
  });
}

test("a follow-up the mode approved: blocked not_approved during the campaign's first 7 days, whatever its mode says, nothing sent; in review_first_touches after them, sent with the AI disclosure line, the gate's checks naming the mode, the follow-up and the mode's origin", async () => {
  const s = await sender();
  const seeded = await s.run(() => seedCampaign());
  assert.ok(seeded);
  const lighter = { approvalMode: "review_first_touches" } as const;
  await app.campaign.update({ where: { id: seeded.id }, data: lighter });
  const locked = await s.ready("mode-locked", "follow_up_1", TEXT);
  await approvedByMode(locked.id);
  const refused = await s.send();
  assert.deepEqual(refused.result, { sent: 0, blocked: 1, refused: 0, end: "no_step" });
  assert.deepEqual(sends(), [], "nothing sent");
  const blocked = await stepOf(locked.id);
  assert.deepEqual([blocked.status, blocked.skipReason], ["skipped", "not_approved"]);

  // The 7 days over.
  await app.campaign.update({ where: { id: seeded.id }, data: { reviewLockedUntil: new Date(0) } });
  const step = await s.ready("mode-follow-up", "follow_up_1", TEXT, afterSend());
  await approvedByMode(step.id);
  const { result } = await s.send();
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  assert.deepEqual(
    sends().map(({ method, input }) => [method, (input as { text?: string }).text]),
    [["sendMessage", FROZEN]],
  );
  const row = await stepOf(step.id);
  assert.equal(row.status, "succeeded");
  const checks = row.jitChecks as { contentHash: string; approval: unknown };
  assert.equal(checks.contentHash, sha256(FROZEN), "the hash covers the line");
  assert.deepEqual(checks.approval, {
    ...{ approvalItemId: row.approvalItemId, status: "approved", contentHash: sha256(FROZEN) },
    ...{ mode: "review_first_touches", firstTouch: false, origin: "approval_mode" },
  });
});

// Safety cases of "Up next" per member (gamma-p6-050; core/modules/approvals/README.md "Routes",
// "Decided here"; docs/security.md "Who decides"), on the LinkedIn fake, the slice's Temporal and a
// schema of its database (fixtures/campaigns-sender.ts). The workspace's Owner, member A (OWNER), and
// a Member, B, each have a connected LinkedIn account; a lead of A's campaign has its connection
// request opened by the queue, its item pending for A. B's approve and skip, as the routes run them
// in B's request, are refused (not_sender_owner): the item stays pending, the step awaiting_approval,
// no decision is published, the gate does not let the step through and neither account's sender
// sends it. An approval written for B past the route's check is refused at the gate: approvals'
// approvedContent answers none for it (not its account's owner's), so the step is skipped
// (content_changed, the gate's word for an approved item with no approved content), nothing
// reserved and no credit. A's approval, delivered to campaigns' subscriber
// as the outbox delivers it, schedules the step, which goes out from A's account.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "@whytide/platform";
import {
  app,
  now,
  OWNER,
  runLoaded,
  type Sender,
  sender,
  sends,
  sha256,
  slotsOf,
  stepOf,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

const { withTenant } = await import("@whytide/db");
const platform = await import("@whytide/platform");
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
const { approve, skip } = await built("approvals/dist/domain/items/decide.js");
const { createApprovalItem } = await built("approvals/dist/testing/index.js");
const { checkGate } = await built("campaigns/dist/domain/gate/gate.js");
const { createStepDraft } = await built("messaging/dist/testing/index.js");

useSenderTests();
const NOTHING = { sent: 0, blocked: 0, refused: 0, end: "no_step" };
const DECIDED = "approvals.item_decided";

/** A member signed in, as the api's guard leaves the principal of a request. */
const signedIn = (s: Sender, userId: string, role: "Owner" | "Member"): Principal => ({
  ...{ userId, actorType: "human", authMethod: "session" },
  ...{ workspaceId: s.workspaceId, role, scopes: [] },
});

/** `fn` in the request's tenant run as the principal: the routes' approve and skip run in it. */
const asRequest = <T>(s: Sender, principal: Principal, fn: () => Promise<T>): Promise<T> =>
  withTenant({ workspaceId: s.workspaceId, principal }, fn, { client: app });

/** The step's item, as the queue opened it. */
const itemOf = (stepExecutionId: string) =>
  app.approvalItem.findFirstOrThrow({ where: { stepExecutionId } });

/** The workspace's approvals.item_decided events, written to the outbox. */
const decisionsOf = (s: Sender) =>
  app.outboxEntry.findMany({ where: { workspaceId: s.workspaceId, eventName: DECIDED } });

/** Each approvals.item_decided delivered to its subscribers, campaigns', as the outbox does. */
async function deliverDecisions(s: Sender): Promise<void> {
  for (const { id, payload, createdAt } of await decisionsOf(s)) {
    await s.run(async (tx) => {
      const context = { id, name: DECIDED, workspaceId: s.workspaceId, createdAt, attempt: 1, tx };
      for (const handler of platform.subscribersOf(DECIDED)) await handler(payload, context);
    });
  }
}

/** Refused as a route refuses another member: 403 not_sender_owner. */
const notSenderOwner = (error: unknown) => {
  const { code, status } = error as { code?: string; status?: number };
  return code === "not_sender_owner" && status === 403;
};

/** The recorded sends as [method, account ref, member ref]. */
const sent = () =>
  sends().map(({ method, input }) => {
    const { providerAccountRef, memberRef } = input as Record<string, string>;
    return [method, providerAccountRef, memberRef];
  });

test("member B's approve and skip of member A's item are refused, not_sender_owner: the item stays pending, the step awaiting_approval, no decision published; the gate does not let the step through and neither account sends it; A's approval sends it from A's account", async () => {
  const s = await sender();
  const b = await s.member();
  const lead = await s.lead("per-member");
  const id = lead.steps.connect as string;
  const queued = await runLoaded<{ opened: number }>("campaigns_queue", {
    workspaceId: s.workspaceId,
  });
  assert.equal(queued.opened, 1);
  const item = await itemOf(id);
  assert.deepEqual(
    [item.status, item.senderAccountId, (await stepOf(id)).status],
    ["pending", s.accountId, "awaiting_approval"],
  );

  const asB = signedIn(s, b.userId, "Member");
  await assert.rejects(
    asRequest(s, asB, () => approve(item.id, {}, asB)),
    notSenderOwner,
  );
  await assert.rejects(
    asRequest(s, asB, () => skip(item.id, asB)),
    notSenderOwner,
  );
  const kept = await itemOf(id);
  assert.deepEqual(
    [kept.status, kept.decidedBy, kept.decidedAt, kept.approvedContentHash],
    ["pending", null, null, null],
  );
  assert.deepEqual(await decisionsOf(s), []);
  await deliverDecisions(s);
  assert.equal((await stepOf(id)).status, "awaiting_approval");
  const gate: { pass: boolean; reason?: string } = await s.run(() => checkGate(id, { at: now() }));
  assert.deepEqual([gate.pass, gate.reason], [false, "step_not_ready"]);
  assert.deepEqual((await s.send()).result, NOTHING);
  assert.deepEqual((await s.send({}, b.accountId)).result, NOTHING);
  assert.deepEqual(sends(), []);
  assert.deepEqual([await slotsOf(id), await usagesOf(id)], [[], []]);

  // A's approval, as the route runs it in A's request, then its event delivered.
  const asA = signedIn(s, OWNER, "Owner");
  await asRequest(s, asA, () => approve(item.id, {}, asA));
  assert.equal((await decisionsOf(s)).length, 1);
  await deliverDecisions(s);
  const scheduled = await stepOf(id);
  assert.deepEqual([scheduled.status, scheduled.draftId], ["scheduled", item.draftId]);
  await s.place(id);
  assert.deepEqual((await s.send({}, b.accountId)).result, NOTHING);
  assert.deepEqual((await s.send()).result, { ...NOTHING, sent: 1 });
  assert.deepEqual(sent(), [["sendInvite", s.ref, lead.memberRef]]);
});

test("an approval written for member B past the route's check, of A's account's step: approvals answers no approved content for it, so the gate skips the step (content_changed), nothing reserved and no credit; no send from either account", async () => {
  const s = await sender();
  const b = await s.member();
  const lead = await s.lead("past-the-route");
  const id = lead.steps.connect as string;
  // The step as campaigns leaves it once its item is approved, the item decided by B, not A.
  const step = { workspaceId: s.workspaceId, personId: lead.personId, stepExecutionId: id };
  const draft = { ...step, stepKey: "connect", status: "approved", text: "" };
  const draftId = await createStepDraft(draft);
  const approvalItemId = await createApprovalItem({
    ...{ ...step, senderAccountId: s.accountId, stepKey: "connect", draftId },
    ...{ status: "approved", approvedContentHash: sha256(""), decidedBy: b.userId },
  });
  const dueAt = new Date(now().getTime() - 60_000);
  const data = { status: "scheduled", approvalItemId, draftId, dueAt } as const;
  await app.stepExecution.update({ where: { id }, data });
  await s.place(id);

  assert.deepEqual((await s.send()).result, { ...NOTHING, blocked: 1 });
  const refused = await stepOf(id);
  assert.deepEqual([refused.status, refused.skipReason], ["skipped", "content_changed"]);
  assert.deepEqual([await slotsOf(id), await usagesOf(id)], [[], []]);
  assert.deepEqual((await s.send({}, b.accountId)).result, NOTHING);
  assert.deepEqual(sends(), []);
});

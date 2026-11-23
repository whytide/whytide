// Safety cases of each campaign sending from its owner's senders (gamma-p6-040;
// core/modules/campaigns/README.md "Enrolling", "The queue", "The gate"; docs/flows.md "A removed
// member"), on the LinkedIn and mailbox fakes, the slice's Temporal and a schema of its database
// (fixtures/campaigns-sender.ts). The workspace's Owner (OWNER) and a Member each have a connected
// LinkedIn account; their agents' campaigns are made as the subscriber to playbooks.playbook_created
// makes them and set active; leads are approved by either member, enrolled by the subscriber's body
// and sent by each account's sender. An email step's mailbox is written as gamma-p4-010 will write
// it, and its gate asked directly, since no sender claims an email step yet. Each case asserts the
// fakes' recorded sends: each send from its campaign owner's account, whoever approved; a removed
// owner's scheduled LinkedIn and email steps blocked at the gate with nothing reserved and no
// credit; an opt-out from one member's campaign keeping the person out of the other's; one active
// enrollment per person across members; and no email from another member's mailbox.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  afterSend,
  app,
  contacts,
  now,
  OWNER,
  runLoaded,
  type Sender,
  sender,
  sends,
  slotsOf,
  starts,
  stepOf,
  usagesOf,
  useSenderTests,
} from "../fixtures/campaigns-sender.ts";

const platform = await import("@whytide/platform");
const { getAdapter, mailboxPort } = await import("@whytide/providers");
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
const { enrollApproved } = await built("campaigns/dist/domain/enroll/enroll.js");
const { checkGate } = await built("campaigns/dist/domain/gate/gate.js");
const { exitSuppressedEnrollments } = await built("campaigns/dist/domain/gate/suppressed.js");
const { endRemovedEnrollments } = await built("campaigns/dist/domain/removed.js");
const campaigns = await built("campaigns/dist/testing/index.js");
const email = await built("email/dist/testing/index.js");
const { createPlaybook } = await built("playbooks/dist/testing/index.js");

useSenderTests();
email.useEmailClient(app);
email.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
const mailbox = (await getAdapter(mailboxPort, "fake")) as unknown as {
  recordedCalls: { method: string }[];
};
const mailed = () => mailbox.recordedCalls.filter(({ method }) => method === "sendMessage");
const OPT_OUT = { source: "manual", createdBy: OWNER };
const IMPORTED = { kind: "imported", ref: "imp_senders" } as const;
const signal = (ref: string) => ({ kind: "signal", ref }) as const;
const NOTHING = { sent: 0, blocked: 0, refused: 0, end: "no_step" };

type Source = { readonly kind: "signal" | "imported"; readonly ref: string };
type Enrolled = Awaited<ReturnType<typeof approved>>;

/** An agent of `ownerUserId` holding the source, its campaign made and set active; its key_ref. */
async function agentCampaign(s: Sender, ownerUserId: string, sourceId: string): Promise<string> {
  const { workspaceId } = s;
  const agent = { workspaceId, icpId: `icp_${sourceId}`, ownerUserId, sourceIds: [sourceId] };
  const playbookId: string = await createPlaybook(agent, app);
  const { id } = await campaigns.createAgentCampaign({ workspaceId, playbookId, ownerUserId }, app);
  await campaigns.setCampaignActive({ workspaceId, campaignId: id }, app);
  return (await app.campaign.findUniqueOrThrow({ where: { id } })).keyRef;
}

/** contacts.lead_approved delivered for the person: the subscriber's body in a run; its outcome. */
function enroll(s: Sender, personId: string, approvedBy: string): Promise<string> {
  const approval = { sourceEventId: platform.newId("obx"), personId, approvedBy };
  return s.run((tx) => enrollApproved(tx, approval));
}

/** A person with a member ref, their lead from the source approved by `approvedBy` and enrolled. */
async function approved(s: Sender, slug: string, source: Source, approvedBy: string) {
  const memberRef = `member-${randomUUID()}`;
  const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID().slice(0, 8)}`;
  const personId: string = await s.run(async () => {
    const profile = { linkedinUrl, providerId: memberRef, firstName: "Noor" };
    const { person } = await contacts.upsertPersonFromSource({
      ...{ source: "linkedin", provider: "unipile", profile },
    });
    await contacts.createLeadForPerson({ personId: person.id, source });
    await contacts.recordLeadStatus(person.id, "approved", {
      actor: { type: "user", id: approvedBy },
    });
    return person.id;
  });
  const outcome = await enroll(s, personId, approvedBy);
  return { personId, memberRef, outcome, ...(await enrolledOf(personId)) };
}

/** The person's enrollments, oldest first, and their steps' ids by key. */
async function enrolledOf(personId: string) {
  const enrollments = await app.enrollment.findMany({
    where: { personId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const rows = await app.stepExecution.findMany({ where: { personId } });
  const steps: Record<string, string> = Object.fromEntries(
    rows.map(({ stepKey, id }: { stepKey: string; id: string }) => [stepKey, id]),
  );
  return { enrollments, steps };
}

/** The connection request approved by its account's owner and placed at `at`. */
async function readyToSend(s: Sender, lead: Enrolled, at = now()): Promise<void> {
  const id = lead.steps.connect as string;
  await s.approve(id, "");
  await s.place(id, at);
}

/** The email step as gamma-p4-010 will leave it: its mailbox written once, due and scheduled. */
async function scheduledEmail(id: string, mailboxId: string): Promise<void> {
  const data = { mailboxId, status: "scheduled", dueAt: now() } as const;
  await app.stepExecution.update({ where: { id }, data });
}

/** The member removed as tenancy's removeMember leaves the row, its event not delivered yet. */
async function remove(s: Sender, userId: string): Promise<void> {
  const where = { workspaceId: s.workspaceId, userId };
  await app.membership.updateMany({ where, data: { removedAt: now(), removedBy: OWNER } });
}

/** The recorded sends as [method, account ref, member ref], sorted. */
const sent = () =>
  sends()
    .map(({ method, input }) => {
      const { providerAccountRef, memberRef } = input as Record<string, string>;
      return [method, providerAccountRef, memberRef];
    })
    .sort();
/** The gate's answer for the step now, as a sender's claim asks it. */
const gateOf = (s: Sender, id: string): Promise<{ pass: boolean; reason?: string }> =>
  s.run(() => checkGate(id, { at: now() }));
const enrollmentOf = (id: string) => app.enrollment.findUniqueOrThrow({ where: { id } });
const leadStatusOf = async (personId: string) =>
  (await app.lead.findFirstOrThrow({ where: { personId } })).outreachStatus;

test("two members' campaigns: every send goes from its campaign owner's account, whoever approved; a Member's lead in the seeded campaign goes from the workspace Owner's", async () => {
  const s = await sender();
  const member = await s.member();
  const ownersCampaign = await agentCampaign(s, OWNER, "src_senders_owner");
  const membersCampaign = await agentCampaign(s, member.userId, "src_senders_member");
  const approvedByMember = await approved(
    s,
    "owners-agent",
    signal("src_senders_owner"),
    member.userId,
  );
  const approvedByOwner = await approved(s, "members-agent", signal("src_senders_member"), OWNER);
  const seeded = await approved(s, "seeded", IMPORTED, member.userId);

  const enrolled = [approvedByMember, approvedByOwner, seeded].map(({ outcome, enrollments }) =>
    enrollments.map(({ templateId, senderAccountId }) => [outcome, templateId, senderAccountId]),
  );
  assert.deepEqual(enrolled, [
    [["enrolled", ownersCampaign, s.accountId]],
    [["enrolled", membersCampaign, member.accountId]],
    [["enrolled", "linkedin_default", s.accountId]],
  ]);
  const accounts = await app.stepExecution.findMany({
    where: { personId: approvedByOwner.personId, actionType: { not: "email" } },
    select: { senderAccountId: true },
  });
  assert.deepEqual(
    [...new Set(accounts.map(({ senderAccountId }) => senderAccountId))],
    [member.accountId],
  );

  await readyToSend(s, approvedByMember);
  await readyToSend(s, seeded, afterSend());
  assert.equal((await s.send()).result.sent, 2);
  await readyToSend(s, approvedByOwner);
  assert.equal((await s.send({}, member.accountId)).result.sent, 1);
  assert.deepEqual(
    sent(),
    [
      ["sendInvite", s.ref, approvedByMember.memberRef],
      ["sendInvite", s.ref, seeded.memberRef],
      ["sendInvite", member.ref, approvedByOwner.memberRef],
    ].sort(),
  );
});

test("an owner removed: a scheduled LinkedIn step and a scheduled email step are blocked at the gate (owner_removed), nothing reserved, no credit, no send on either fake; the queue opens no item; the subscriber ends the rest once", async () => {
  const s = await sender();
  const member = await s.member();
  await agentCampaign(s, member.userId, "src_senders_removed");
  const membersMailbox = await email.createConnectedMailbox(s.workspaceId, {
    ownerUserId: member.userId,
  });
  const linkedinStep = await approved(s, "removed-linkedin", signal("src_senders_removed"), OWNER);
  const emailStep = await approved(s, "removed-email", signal("src_senders_removed"), OWNER);
  const due = await approved(s, "removed-due", signal("src_senders_removed"), OWNER);
  await readyToSend(s, linkedinStep);
  await scheduledEmail(emailStep.steps.email_1 as string, membersMailbox.id);
  // Due by the queue's clock, which runs from a past Thursday.
  const dueAt = { dueAt: now() };
  await app.stepExecution.update({ where: { id: due.steps.connect as string }, data: dueAt });
  await remove(s, member.userId);

  const { result } = await s.send({}, member.accountId);
  assert.deepEqual(result, { ...NOTHING, blocked: 1 });
  const answer = await gateOf(s, emailStep.steps.email_1 as string);
  assert.deepEqual([answer.pass, answer.reason], [false, "owner_removed"]);
  for (const lead of [linkedinStep, emailStep]) {
    const id = (lead === linkedinStep ? lead.steps.connect : lead.steps.email_1) as string;
    const step = await stepOf(id);
    assert.deepEqual([step.status, step.skipReason], ["cancelled", "owner_removed"]);
    assert.deepEqual([await slotsOf(id), await usagesOf(id)], [[], []]);
    const [enrollment] = lead.enrollments;
    const ended = await enrollmentOf(enrollment?.id ?? "");
    assert.deepEqual(
      [ended.status, ended.exitReason, ended.exitDetail],
      ["exited", "no_sender", "owner_removed"],
    );
    assert.equal(await leadStatusOf(lead.personId), "finished");
    const pending = await app.stepExecution.count({
      where: { personId: lead.personId, status: { in: ["planned", "scheduled"] } },
    });
    assert.equal(pending, 0);
  }
  assert.deepEqual([sends(), mailed()], [[], []]);

  // The removed owner's step due in the queue: no item, no draft asked for; the step waits.
  starts.length = 0;
  const counts = await runLoaded<{ opened: number; noSender: number }>("campaigns_queue", {
    workspaceId: s.workspaceId,
  });
  assert.deepEqual([counts.opened, counts.noSender], [0, 1]);
  assert.equal(await app.approvalItem.count({ where: { personId: due.personId } }), 0);
  assert.deepEqual(starts, []);
  assert.equal((await stepOf(due.steps.connect as string)).status, "planned");

  // tenancy.member_removed delivered: the enrollment left ends, once.
  assert.equal(await s.run((tx) => endRemovedEnrollments(tx, member.userId, now())), 1);
  assert.equal(await s.run((tx) => endRemovedEnrollments(tx, member.userId, now())), 0);
  const [left] = due.enrollments;
  const ended = await enrollmentOf(left?.id ?? "");
  assert.deepEqual([ended.status, ended.exitDetail], ["exited", "owner_removed"]);
  assert.deepEqual([sends(), mailed()], [[], []]);
});

test("an opt-out from the Owner's campaign: the Member's approval of the person enrolls them nowhere, and the queue opens no item for them", async () => {
  const s = await sender();
  const member = await s.member();
  const membersCampaign = await agentCampaign(s, member.userId, "src_senders_opt_out");
  const lead = await approved(s, "opted-out", IMPORTED, OWNER);
  assert.equal(lead.outcome, "enrolled");
  await s.run(() => contacts.addOptOut(lead.personId, OPT_OUT));
  assert.equal(await s.run((tx) => exitSuppressedEnrollments(tx, now())), 1);
  // The Member's agent finds the person: its source is their first signal source.
  await s.run(() =>
    contacts.createLeadForPerson({
      personId: lead.personId,
      source: signal("src_senders_opt_out"),
    }),
  );

  assert.equal(await enroll(s, lead.personId, member.userId), "suppressed");
  const { enrollments } = await enrolledOf(lead.personId);
  assert.deepEqual(
    enrollments.map(({ templateId, status, exitReason, exitDetail, senderAccountId }) => [
      ...[templateId, status, exitReason, exitDetail, senderAccountId],
    ]),
    [
      ["linkedin_default", "exited", "suppressed", "opted_out", s.accountId],
      [membersCampaign, "exited", "suppressed", "opted_out", null],
    ],
  );
  const counts = await runLoaded<{ opened: number }>("campaigns_queue", {
    workspaceId: s.workspaceId,
  });
  assert.equal(counts.opened, 0);
  assert.equal(await app.approvalItem.count({ where: { personId: lead.personId } }), 0);
  assert.deepEqual((await s.send()).result, NOTHING);
  assert.deepEqual((await s.send({}, member.accountId)).result, NOTHING);
  assert.deepEqual(sends(), []);
});

test("one active enrollment per person across members: the Member's approval of a person active in the Owner's campaign makes no second enrollment, and the one send goes from the Owner's account", async () => {
  const s = await sender();
  const member = await s.member();
  await agentCampaign(s, member.userId, "src_senders_active");
  const lead = await approved(s, "active-elsewhere", IMPORTED, member.userId);
  assert.equal(lead.outcome, "enrolled");
  await s.run(() =>
    contacts.createLeadForPerson({ personId: lead.personId, source: signal("src_senders_active") }),
  );

  assert.equal(await enroll(s, lead.personId, member.userId), "enrolled_already");
  const { enrollments } = await enrolledOf(lead.personId);
  assert.deepEqual(
    enrollments.map(({ templateId, status, senderAccountId }) => [
      ...[templateId, status, senderAccountId],
    ]),
    [["linkedin_default", "active", s.accountId]],
  );
  assert.equal(await app.stepExecution.count({ where: { senderAccountId: member.accountId } }), 0);
  await readyToSend(s, lead);
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual((await s.send({}, member.accountId)).result, NOTHING);
  assert.deepEqual(sent(), [["sendInvite", s.ref, lead.memberRef]]);
});

/** The step's gate: sender_mismatch, the step skipped, nothing reserved, the enrollment on. */
async function assertMismatch(s: Sender, lead: Enrolled): Promise<void> {
  const id = lead.steps.email_1 as string;
  const answer = await gateOf(s, id);
  assert.deepEqual([answer.pass, answer.reason], [false, "sender_mismatch"]);
  const step = await stepOf(id);
  assert.deepEqual([step.status, step.skipReason], ["skipped", "sender_mismatch"]);
  assert.deepEqual([await slotsOf(id), await usagesOf(id)], [[], []]);
  const [enrollment] = lead.enrollments;
  assert.equal((await enrollmentOf(enrollment?.id ?? "")).status, "active");
}

test("one member's senders: the Owner's enrollment with only the Member's mailbox connected never sends from it: written on its email step, it is skipped at the gate (sender_mismatch), no send, and the LinkedIn steps go on", async () => {
  const s = await sender();
  const member = await s.member();
  await agentCampaign(s, OWNER, "src_senders_mailbox");
  const membersMailbox = await email.createConnectedMailbox(s.workspaceId, {
    ownerUserId: member.userId,
  });
  const lead = await approved(s, "members-mailbox", signal("src_senders_mailbox"), member.userId);
  assert.equal(lead.enrollments[0]?.senderAccountId, s.accountId);
  await scheduledEmail(lead.steps.email_1 as string, membersMailbox.id);

  await assertMismatch(s, lead);
  await readyToSend(s, lead);
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(sent(), [["sendInvite", s.ref, lead.memberRef]]);
  assert.deepEqual(mailed(), []);
});

test("one member's senders: a mailbox whose owner changed after it was chosen (the Owner's address reconnected by the Member) is skipped at the gate (sender_mismatch), no send, and the LinkedIn steps go on", async () => {
  const s = await sender();
  const member = await s.member();
  await agentCampaign(s, OWNER, "src_senders_reconnected");
  const ownersMailbox = await email.createConnectedMailbox(s.workspaceId, { ownerUserId: OWNER });
  const lead = await approved(s, "changed-owner", signal("src_senders_reconnected"), OWNER);
  await scheduledEmail(lead.steps.email_1 as string, ownersMailbox.id);
  // Reconnected by the Member: gamma-p1-010 gives the address to whoever connected it last.
  const owned = { ownerUserId: member.userId };
  await app.mailbox.update({ where: { id: ownersMailbox.id }, data: owned });

  await assertMismatch(s, lead);
  await readyToSend(s, lead);
  assert.equal((await s.send()).result.sent, 1);
  assert.deepEqual(sent(), [["sendInvite", s.ref, lead.memberRef]]);
  assert.deepEqual(mailed(), []);
});

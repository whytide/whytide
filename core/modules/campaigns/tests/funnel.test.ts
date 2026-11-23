// The Results page's funnel (gamma-p6-080; README.md "Routes"; docs/concepts.md "The funnel") on the
// worktree's database, in this file's schema: campaignFunnels in a member's tenant run, as the api's
// route runs it, on rows written as campaigns, its sender and gamma-p4-050's reply labels leave them
// (createEnrollment). Each measure's rule: an enrollment once per stage, however many steps it sent;
// a step not succeeded no send; a withdrawal no send, and never the step a reply answers; no
// out_of_office or bounce a reply; a reply on the channel of the last step sent before it, on none
// without one; the latest label counted, a correction's. Who sees what: a holder of
// campaigns.manage every campaign by name, with its owner's name, null for a removed or nameless
// member's; a Member her own without names, none without one. Another workspace's rows, under the
// seeded campaign's key_ref both share, never count. The route is the api host's test,
// core/apps/api/tests/campaigns-funnel.test.ts.
import assert from "node:assert/strict";
import test from "node:test";
import { withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { type Principal, type Role, servicePrincipal } from "@whytide/platform";
import { removeMember } from "@whytide/tenancy";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import { seedCampaign } from "../domain/campaigns/commands.ts";
import { campaignFunnels } from "../domain/funnel.ts";
import {
  createDraftCampaign,
  createEnrollment,
  type SeededEnrollment,
  type SeededStep,
  setCampaignActive,
} from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);

type Member = { readonly userId: string; readonly membershipId: string; readonly role: Role };

/** The funnel as the member reads it, in a run of the workspace, as the api's guard binds them. */
function funnelsOf(workspaceId: string, { userId, membershipId, role }: Member) {
  const principal: Principal = {
    userId,
    actorType: "human",
    authMethod: "session",
    membershipId,
    workspaceId,
    role,
    scopes: [],
  };
  return withTenant({ workspaceId, principal }, () => campaignFunnels(), { client: app });
}

/** A run of the workspace as tenancy's and campaigns' services run one. */
const inRun = <T>(workspaceId: string, fn: () => Promise<T>) =>
  withTenant({ workspaceId, principal: servicePrincipal("funnel_test") }, fn, { client: app });

/** A new user, a member of the workspace with the role; the name given replaces the factory's. */
async function member(workspaceId: string, role: Role, name?: string | null) {
  const user = await createUser();
  if (name !== undefined)
    await app.user.update({ where: { id: user.id }, data: { displayName: name } });
  const { id: membershipId } = await createMembership({ userId: user.id, workspaceId, role });
  return {
    userId: user.id,
    membershipId,
    role,
    name: name === undefined ? user.displayName : name,
  };
}

/** A campaign of the owner's, `active` as a launch leaves it unless a draft is asked for; its id. */
async function campaign(workspaceId: string, ownerUserId: string, name: string, draft = false) {
  const { id } = await createDraftCampaign({ workspaceId, ownerUserId, name }, app);
  if (!draft) await setCampaignActive({ workspaceId, campaignId: id }, app);
  return id;
}

let people = 0;
/** An enrollment of a new person in the campaign (its key_ref, the id of one made here). */
function enroll(workspaceId: string, campaignId: string, rest: Partial<SeededEnrollment> = {}) {
  const personId = `per_funnel_${++people}`;
  const seeded: SeededEnrollment = { workspaceId, personId, senderAccountId: "sac_funnel" };
  return createEnrollment({ ...seeded, templateId: campaignId, ...rest }, app);
}

/** The hour on 2 November 2026, UTC. */
const at = (hour: number) => new Date(Date.UTC(2026, 10, 2, hour));
/** A step sent at the hour, `succeeded` as the sender leaves it. */
function sent(stepKey: string, hour: number, more: Partial<SeededStep> = {}): SeededStep {
  const step: SeededStep = { stepKey, status: "succeeded", executedAt: at(hour) };
  return { ...step, ...more };
}
const emailed = (hour: number) => sent("email_1", hour, { actionType: "email" });
/** An enrollment ended on a reply at the hour, with the label its reply was given. */
function replied(label: string, hour: number): Partial<SeededEnrollment> {
  return { status: "replied", endedAt: at(hour), reply: { label, at: at(hour) } };
}

type Linkedin = [sent: number, accepted: number, replied: number, positive: number];
type Email = [sent: number, replied: number, positive: number];
/** A campaign's numbers as the funnel answers them. */
function numbers(enrolled: number, linkedin: Linkedin, email: Email, total: [number, number]) {
  return {
    enrolled,
    linkedin: {
      sent: linkedin[0],
      accepted: linkedin[1],
      replied: linkedin[2],
      positive: linkedin[3],
    },
    email: { sent: email[0], accepted: null, replied: email[1], positive: email[2] },
    total: { replied: total[0], positive: total[1] },
  };
}

test("each measure counts an enrollment once per stage on its channel: sends, a withdrawal, steps not succeeded, out_of_office and bounce, a reply after an email or before any send, a refused enrollment", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const owner = { userId: a.user.id, membershipId: a.membership.id, role: "Owner" } as const;
  const founders = await campaign(ws, a.user.id, "Founders");
  const agencies = await campaign(ws, a.user.id, "Agencies", true);
  // Three LinkedIn sends and the acceptance, each once; a positive reply to the last.
  await enroll(ws, founders, {
    ...replied("interested", 9),
    steps: [
      sent("connect", 1, { acceptedAt: at(2) }),
      sent("message_1", 3),
      sent("follow_up_1", 5),
    ],
  });
  // A connection request withdrawn, then a reply: it answers the request, not the withdrawal.
  await enroll(ws, founders, {
    ...replied("not_interested", 8),
    steps: [
      sent("connect", 1),
      sent("withdraw", 6, { actionType: "withdraw" }),
      { stepKey: "message_1", status: "cancelled" },
    ],
  });
  // An out-of-office answer and a bounce are no reply.
  await enroll(ws, founders, {
    reply: { label: "out_of_office", at: at(4) },
    steps: [sent("connect", 1)],
  });
  await enroll(ws, founders, { reply: { label: "bounce", at: at(4) }, steps: [emailed(2)] });
  // LinkedIn, then an email, then a positive reply: the email's.
  await enroll(ws, founders, {
    ...replied("interested", 7),
    steps: [
      sent("connect", 1, { acceptedAt: at(2) }),
      sent("message_1", 3),
      emailed(5),
      { stepKey: "follow_up_1", status: "held", skipReason: "replied" },
    ],
  });
  // A reply before the first send: on no channel, in the totals only.
  await enroll(ws, founders, { ...replied("interested", 1), steps: [sent("connect", 2)] });
  // Steps that did not go out, a time on each as a stale one could have: no send.
  await enroll(ws, founders, {
    steps: [
      { stepKey: "connect", status: "failed", executedAt: at(1) },
      { stepKey: "message_1", status: "executing", executedAt: at(2) },
    ],
  });
  await enroll(ws, founders, { steps: [{ stepKey: "connect", status: "scheduled" }] });
  // Refused as it was made: no sender, never started, never enrolled.
  await enroll(ws, founders, { senderAccountId: null, status: "exited", startedAt: null });
  // Another campaign's: counted under it.
  await enroll(ws, agencies, { steps: [sent("connect", 1)] });

  assert.deepEqual(await funnelsOf(ws, owner), [
    {
      ...{ campaignId: agencies, name: "Agencies", status: "draft", ownerName: a.user.displayName },
      ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]),
    },
    {
      ...{
        campaignId: founders,
        name: "Founders",
        status: "active",
        ownerName: a.user.displayName,
      },
      ...numbers(8, [5, 2, 2, 1], [2, 1, 1], [4, 3]),
    },
  ]);
});

test("the latest label counts: a positive reply corrected to not_now stays a reply and is no longer positive; corrected to out_of_office, no reply", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const owner = { userId: a.user.id, membershipId: a.membership.id, role: "Owner" } as const;
  const id = await campaign(ws, a.user.id, "Corrections");
  const { id: enrollmentId } = await enroll(ws, id, {
    ...replied("interested", 5),
    steps: [sent("connect", 1, { acceptedAt: at(2) }), sent("message_1", 3)],
  });
  const read = async () =>
    (await funnelsOf(ws, owner)).map(({ linkedin, total }) => ({ linkedin, total }));
  /** A member's correction, as gamma-p4-050 leaves it: the same reply, a new label. */
  const correct = (label: string) =>
    app.enrollment.updateMany({ where: { id: enrollmentId }, data: { replyLabel: label } });

  const linkedin = (replies: number, positive: number) => ({
    linkedin: { sent: 1, accepted: 1, replied: replies, positive },
    total: { replied: replies, positive },
  });
  assert.deepEqual(await read(), [linkedin(1, 1)]);
  await correct("not_now");
  assert.deepEqual(await read(), [linkedin(1, 0)]);
  await correct("out_of_office");
  assert.deepEqual(await read(), [linkedin(0, 0)]);
  await correct("interested");
  assert.deepEqual(await read(), [linkedin(1, 1)]);
});

test("an Owner and an Admin see every campaign by name with its owner's name, null for a removed or nameless member's; a Member sees her own without names; a Member without one sees none", async () => {
  const [a] = await createTwoWorkspaces();
  const ws = a.workspace.id;
  const owner = { userId: a.user.id, membershipId: a.membership.id, role: "Owner" } as const;
  const admin = await member(ws, "Admin");
  const mia = await member(ws, "Member");
  const idle = await member(ws, "Member");
  const nameless = await member(ws, "Member", null);
  const gone = await member(ws, "Member");
  await inRun(ws, () => seedCampaign());
  const zeta = await campaign(ws, mia.userId, "Zeta");
  const alpha = await campaign(ws, a.user.id, "Alpha", true);
  const left = await campaign(ws, gone.userId, "Left");
  const anon = await campaign(ws, nameless.userId, "Nameless");
  await inRun(ws, () => removeMember({ membershipId: gone.membershipId, removedBy: a.user.id }));
  // The seeded campaign holds beta's enrollments: the default key_ref.
  await createEnrollment(
    { workspaceId: ws, personId: "per_funnel_beta", senderAccountId: "sac_funnel" },
    app,
  );
  await enroll(ws, zeta, { steps: [sent("connect", 1)] });

  const zero = numbers(0, [0, 0, 0, 0], [0, 0, 0], [0, 0]);
  const everyCampaign = (await funnelsOf(ws, owner)).map(({ campaignId, ...rest }) => ({
    ...rest,
    seeded: ![zeta, alpha, left, anon].includes(campaignId),
  }));
  assert.deepEqual(everyCampaign, [
    {
      ...{ name: "", status: "active", ownerName: a.user.displayName },
      ...numbers(1, [0, 0, 0, 0], [0, 0, 0], [0, 0]),
      seeded: true,
    },
    {
      ...{ name: "Alpha", status: "draft", ownerName: a.user.displayName },
      ...zero,
      seeded: false,
    },
    { ...{ name: "Left", status: "active", ownerName: null }, ...zero, seeded: false },
    { ...{ name: "Nameless", status: "active", ownerName: null }, ...zero, seeded: false },
    {
      ...{ name: "Zeta", status: "active", ownerName: mia.name },
      ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]),
      seeded: false,
    },
  ]);
  const ownerView = await funnelsOf(ws, owner);
  assert.deepEqual(await funnelsOf(ws, admin), ownerView);
  // A Member's own campaign, with no ownerName at all.
  assert.deepEqual(await funnelsOf(ws, mia), [
    {
      ...{ campaignId: zeta, name: "Zeta", status: "active" },
      ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]),
    },
  ]);
  assert.deepEqual(await funnelsOf(ws, idle), []);
});

test("another workspace's rows never count, those under the seeded campaign's key_ref both workspaces share and under this one's campaign id included", async () => {
  const [a, b] = await createTwoWorkspaces();
  const owner = { userId: a.user.id, membershipId: a.membership.id, role: "Owner" } as const;
  const ofB = { userId: b.user.id, membershipId: b.membership.id, role: "Owner" } as const;
  await inRun(a.workspace.id, () => seedCampaign());
  await inRun(b.workspace.id, () => seedCampaign());
  const id = await campaign(a.workspace.id, a.user.id, "Mine");
  const full = {
    ...replied("interested", 5),
    steps: [sent("connect", 1, { acceptedAt: at(2) }), emailed(3)],
  };
  // B's: two under the seeded key_ref, one under A's campaign id.
  for (const templateId of ["linkedin_default", "linkedin_default", id]) {
    await enroll(b.workspace.id, templateId, full);
  }
  await enroll(a.workspace.id, id, { steps: [sent("connect", 1)] });

  const counts = async (who: Member, workspaceId: string) =>
    (await funnelsOf(workspaceId, who)).map(({ name, enrolled, linkedin, email, total }) => ({
      ...{ name, enrolled, linkedin, email, total },
    }));
  assert.deepEqual(await counts(owner, a.workspace.id), [
    { name: "", ...numbers(0, [0, 0, 0, 0], [0, 0, 0], [0, 0]) },
    { name: "Mine", ...numbers(1, [1, 0, 0, 0], [0, 0, 0], [0, 0]) },
  ]);
  assert.deepEqual(await counts(ofB, b.workspace.id), [
    { name: "", ...numbers(2, [2, 2, 0, 0], [2, 2, 2], [2, 2]) },
  ]);
});

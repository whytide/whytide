// The Results page's funnel (README.md "Routes"; docs/concepts.md "The funnel"), in the caller's
// tenant run: for each campaign the caller sees, by name, the people enrolled, then on each channel
// those sent to, who accepted, replied and replied positively. Every number counts enrollments,
// each once per stage, from campaigns' own rows: an enrollment that started; one with a step
// `succeeded` on the channel, a withdrawal never one; a connection request with an `accepted_at`; a
// reply label (gamma-p4-050) that is a reply, on the channel of the last step sent before the
// reply; of those, the latest label `interested`. Each measure is one query, grouped by campaign
// (template_id, its key_ref) and channel. A holder of campaigns.manage sees every campaign, with
// its owner's name (tenancy's listMembers: null once the owner is no member, or has no name);
// anyone else sees their own (owner_user_id). Ids, names, codes and numbers only: no person, no
// text, no email address.
import { Prisma, tenantClient } from "@whytide/db";
import { can, currentTenant } from "@whytide/platform";
import { listMembers } from "@whytide/tenancy";
import { permissions } from "../permissions.ts";
import {
  ACTION_CHANNELS,
  type CampaignStatus,
  SEQUENCE_ACTIONS,
  type StepChannel,
} from "./campaigns/constants.ts";
import { NOT_REPLY_LABELS, POSITIVE_LABEL } from "./constants.ts";

/** A channel's numbers; email has no acceptance. */
export type LinkedinNumbers = {
  readonly sent: number;
  readonly accepted: number;
  readonly replied: number;
  readonly positive: number;
};
export type EmailNumbers = Omit<LinkedinNumbers, "accepted"> & { readonly accepted: null };

/** A campaign's numbers; `ownerName` in the view of a holder of campaigns.manage only. */
export type CampaignFunnel = {
  readonly campaignId: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly ownerName?: string | null;
  readonly enrolled: number;
  readonly linkedin: LinkedinNumbers;
  readonly email: EmailNumbers;
  /** Every reply, on a channel or none (no step sent before it). */
  readonly total: { readonly replied: number; readonly positive: number };
};

type Measure = "enrolled" | "sent" | "accepted" | "replied" | "positive";
/** The workspace, and the key_refs of the campaigns read. */
type Scope = { readonly workspaceId: string; readonly keyRefs: Prisma.Sql };
/** A measure's number for a campaign on a channel; null, a reply with no step sent before it. */
type Counted = { readonly keyRef: string; readonly channel: string | null; readonly count: number };
/** A measure's numbers by key_ref, then by channel. */
type Tally = ReadonlyMap<string, ReadonlyMap<string | null, number>>;

/** A step's channel by its action (ACTION_CHANNELS); none for a withdrawal, which sends nothing. */
const CHANNEL = Prisma.sql`CASE s.action_type::text ${Prisma.join(
  SEQUENCE_ACTIONS.map((action) => Prisma.sql`WHEN ${action} THEN ${ACTION_CHANNELS[action]}`),
  " ",
)} END`;
/** A step sent to the person: `succeeded`, as the counts count a send, a withdrawal never. */
const SENT = Prisma.sql`s.status = 'succeeded' AND s.action_type::text IN (${Prisma.join(
  SEQUENCE_ACTIONS,
)})`;

/**
 * Each measure's rows in the scope: the campaign's key_ref, the channel and the enrollment, which
 * the count takes once per campaign and channel.
 */
const SOURCES: Readonly<Record<Measure, (scope: Scope) => Prisma.Sql>> = {
  enrolled: ({ workspaceId, keyRefs }) => Prisma.sql`
    SELECT e.template_id, NULL::text AS channel, e.id AS enrollment_id FROM enrollments e
    WHERE e.workspace_id = ${workspaceId} AND e.template_id IN (${keyRefs})
      AND e.started_at IS NOT NULL`,
  sent: ({ workspaceId, keyRefs }) => Prisma.sql`
    SELECT s.template_id, ${CHANNEL} AS channel, s.enrollment_id FROM step_executions s
    WHERE s.workspace_id = ${workspaceId} AND s.template_id IN (${keyRefs}) AND ${SENT}`,
  accepted: ({ workspaceId, keyRefs }) => Prisma.sql`
    SELECT s.template_id, ${CHANNEL} AS channel, s.enrollment_id FROM step_executions s
    WHERE s.workspace_id = ${workspaceId} AND s.template_id IN (${keyRefs})
      AND s.action_type = 'invite' AND s.accepted_at IS NOT NULL`,
  replied: (scope) => replies(scope, Prisma.empty),
  positive: (scope) => replies(scope, Prisma.sql`AND e.reply_label = ${POSITIVE_LABEL}`),
};
const MEASURES = Object.keys(SOURCES) as Measure[];

/**
 * The enrollments whose latest label is a reply, each with the channel of its last step sent before
 * the reply (`reply_label_at`, the reply's instant): none when nothing was sent before it.
 */
function replies({ workspaceId, keyRefs }: Scope, more: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
    SELECT e.template_id, last.channel, e.id AS enrollment_id FROM enrollments e
    LEFT JOIN LATERAL (
      SELECT ${CHANNEL} AS channel FROM step_executions s
      WHERE s.workspace_id = e.workspace_id AND s.enrollment_id = e.id AND ${SENT}
        AND s.executed_at < e.reply_label_at
      ORDER BY s.executed_at DESC, s.position DESC, s.id DESC
      LIMIT 1
    ) AS last ON TRUE
    WHERE e.workspace_id = ${workspaceId} AND e.template_id IN (${keyRefs})
      AND e.reply_label IS NOT NULL AND e.reply_label NOT IN (${Prisma.join(NOT_REPLY_LABELS)})
      ${more}`;
}

/**
 * The funnel of each campaign the caller sees, by name in code-unit order, then by id: every
 * campaign with its owner's name for a holder of campaigns.manage, else the caller's own; none
 * without one.
 */
export async function campaignFunnels(): Promise<CampaignFunnel[]> {
  const { workspaceId, principal } = currentTenant();
  const everyone = can(principal, permissions["campaigns.manage"]) === "allow";
  const campaigns = await tenantClient.campaign.findMany({
    where: everyone ? {} : { ownerUserId: principal.userId },
    select: { id: true, keyRef: true, name: true, status: true, ownerUserId: true },
  });
  if (campaigns.length === 0) return [];
  const scope = { workspaceId, keyRefs: Prisma.join(campaigns.map(({ keyRef }) => keyRef)) };
  const tallies = new Map<Measure, Tally>();
  for (const measure of MEASURES)
    tallies.set(measure, tallyOf(await countOf(SOURCES[measure](scope))));
  const owners = everyone ? await ownerNames() : null;
  const at = (measure: Measure, keyRef: string, channel: StepChannel | null) =>
    tallies.get(measure)?.get(keyRef)?.get(channel) ?? 0;
  const all = (measure: Measure, keyRef: string) =>
    [...(tallies.get(measure)?.get(keyRef)?.values() ?? [])].reduce((sum, n) => sum + n, 0);
  const funnels = campaigns.map(({ id, keyRef, name, status, ownerUserId }): CampaignFunnel => {
    const on = (channel: StepChannel) => ({
      sent: at("sent", keyRef, channel),
      replied: at("replied", keyRef, channel),
      positive: at("positive", keyRef, channel),
    });
    return {
      ...{ campaignId: id, name, status },
      ...(owners !== null && { ownerName: owners.get(ownerUserId) ?? null }),
      enrolled: all("enrolled", keyRef),
      linkedin: { ...on("linkedin"), accepted: at("accepted", keyRef, "linkedin") },
      email: { ...on("email"), accepted: null },
      total: { replied: all("replied", keyRef), positive: all("positive", keyRef) },
    };
  });
  return funnels.sort(byName);
}

/** A measure's numbers per campaign and channel in one query: each enrollment once. */
function countOf(source: Prisma.Sql): Promise<Counted[]> {
  return tenantClient.$queryRaw<Counted[]>`
    SELECT measured.template_id AS "keyRef", measured.channel,
      COUNT(DISTINCT measured.enrollment_id)::int AS "count"
    FROM (${source}) AS measured
    GROUP BY measured.template_id, measured.channel`;
}

function tallyOf(rows: readonly Counted[]): Tally {
  const tally = new Map<string, Map<string | null, number>>();
  for (const { keyRef, channel, count } of rows) {
    const channels = tally.get(keyRef) ?? new Map<string | null, number>();
    channels.set(channel, count);
    tally.set(keyRef, channels);
  }
  return tally;
}

/** The workspace's active members' names by user id: null for one who gave none. */
async function ownerNames(): Promise<ReadonlyMap<string, string | null>> {
  const members = await listMembers();
  return new Map(members.map(({ userId, displayName }) => [userId, displayName]));
}

/** By name in code-unit order, the seeded campaign's empty name first; then by id. */
function byName(a: CampaignFunnel, b: CampaignFunnel): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
}

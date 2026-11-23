// contacts' outreach-status commands (README.md "Public interface"; docs/flows.md "Approve"), inside
// the caller's tenant run like every command of contacts (../persons.ts): a status change with its
// record, Approve, and a lead's changes. Every change of the status goes through recordLeadStatus;
// nothing updates a change, and erasePerson alone deletes a person's.
import { outboxWriter, tenantClient } from "@whytide/db";
import { AppError, currentTenant, newId, publish } from "@whytide/platform";
import type { z } from "zod";
import { errors } from "../../errors.ts";
import { events } from "../../events.ts";
import { ids } from "../../ids.ts";
import { touchSettings } from "../../settings.ts";
import { parseInput, requireId } from "../rules.ts";
import { suppressionOf } from "../suppression/checks.ts";
import { type OutreachStatus, STATUS_CHANGES_LIMIT, type StatusActorType } from "./constants.ts";
import { actorOf, approvableFrom, recordStatusInput, type StatusActor } from "./rules.ts";

export type LeadStatusChange = {
  readonly id: string;
  readonly workspaceId: string;
  readonly personId: string;
  readonly fromStatus: OutreachStatus;
  readonly toStatus: OutreachStatus;
  /** The campaign's template that moved the lead, for in_campaign and finished. */
  readonly templateId: string | null;
  /** A code, such as opted_out. */
  readonly reason: string | null;
  readonly actorType: StatusActorType;
  /** The user's id; null for the system. */
  readonly actorId: string | null;
  readonly createdAt: Date;
};

/**
 * Moves the lead's outreach status to `to` and records the change, one row, with the reason, the
 * template and the actor; the lead's row is locked until the caller's transaction ends, so two
 * changes at once queue. The status already `to` writes nothing and answers null. The update is raw,
 * so that updated_at, the time of qualification the list shows, stays. lead_not_found;
 * contacts_input_invalid naming the fields at fault.
 */
export async function recordLeadStatus(
  personId: string,
  to: OutreachStatus,
  options: { reason?: string; templateId?: string; actor: StatusActor },
): Promise<LeadStatusChange | null> {
  const input = parseInput(recordStatusInput, { ...options, personId, to });
  const from = await lockedStatus(input.personId);
  return from === input.to ? null : change(from, input);
}

/**
 * Approves the lead for outreach as the run's user: from pending_review, from approved again (the
 * event is published again), and from suppressed once the never-contact check allows it and the
 * lead was never in a campaign. Publishes contacts.lead_approved in the same transaction; campaigns
 * enrolls the lead. lead_in_outreach from in_campaign, replied or finished, or from suppressed after
 * a campaign; person_suppressed, with the check's reason in details, for a person the check refuses
 * as a new enrollment, recently_contacted included, with `days`, CONTACTS_RECENT_TOUCH_DAYS, which
 * the screen's words name; lead_not_found.
 */
export async function approveLead(personId: string): Promise<OutreachStatus> {
  const id = requireId("personId", personId);
  const { workspaceId, principal } = currentTenant();
  const from = await lockedStatus(id);
  const everInCampaign = from === "suppressed" && (await wasInCampaign(id));
  if (!approvableFrom(from, everInCampaign)) throw new AppError(errors.lead_in_outreach);
  const suppression = await suppressionOf(id, { newEnrollment: true });
  if (suppression.suppressed) {
    const { reason } = suppression;
    const days = touchSettings.CONTACTS_RECENT_TOUCH_DAYS;
    const details = reason === "recently_contacted" ? { reason, days } : { reason };
    throw new AppError(errors.person_suppressed, { details });
  }
  await recordLeadStatus(id, "approved", { actor: actorOf(principal) });
  const payload = { personId: id, approvedBy: principal.userId };
  await publish(outboxWriter(tenantClient, workspaceId), events["contacts.lead_approved"], payload);
  return "approved";
}

/** The lead's status changes, newest first, STATUS_CHANGES_LIMIT at most. lead_not_found. */
export async function listStatusChanges(personId: string): Promise<LeadStatusChange[]> {
  const id = requireId("personId", personId);
  const lead = await tenantClient.lead.findFirst({
    where: { personId: id },
    select: { personId: true },
  });
  if (lead === null) throw new AppError(errors.lead_not_found);
  const rows = await tenantClient.leadStatusChange.findMany({
    where: { personId: id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: STATUS_CHANGES_LIMIT,
  });
  return rows as LeadStatusChange[];
}

/**
 * The lead's outreach status, its row locked until the caller's transaction ends, so that a change
 * of it waits for that transaction; null for a person without a lead. What campaigns reads before
 * it enrolls the lead or records its reply. contacts_input_invalid for no id.
 */
export async function lockLeadStatus(personId: string): Promise<OutreachStatus | null> {
  const id = requireId("personId", personId);
  const { workspaceId } = currentTenant();
  const [lead] = await tenantClient.$queryRaw<{ status: OutreachStatus }[]>`
    SELECT outreach_status::text AS status FROM leads
    WHERE workspace_id = ${workspaceId} AND person_id = ${id}
    FOR UPDATE`;
  return lead?.status ?? null;
}

/** The lead's outreach status, its row locked until the run's transaction ends; lead_not_found. */
async function lockedStatus(personId: string): Promise<OutreachStatus> {
  const status = await lockLeadStatus(personId);
  if (status === null) throw new AppError(errors.lead_not_found);
  return status;
}

/** Whether the lead was ever in a campaign: a change to in_campaign is on record. */
async function wasInCampaign(personId: string): Promise<boolean> {
  const change = await tenantClient.leadStatusChange.findFirst({
    where: { personId, toStatus: "in_campaign" },
    select: { id: true },
  });
  return change !== null;
}

/** Writes the status, raw so that updated_at stays, and its change row, on the locked lead. */
async function change(
  from: OutreachStatus,
  input: z.output<typeof recordStatusInput>,
): Promise<LeadStatusChange> {
  const { workspaceId } = currentTenant();
  const { personId, to, reason = null, templateId = null, actor } = input;
  await tenantClient.$executeRaw`
    UPDATE leads SET outreach_status = ${to}::lead_outreach_status, outreach_reason = ${reason}
    WHERE workspace_id = ${workspaceId} AND person_id = ${personId}`;
  const row = await tenantClient.leadStatusChange.create({
    data: {
      id: newId(ids.lead_status_change),
      workspaceId,
      personId,
      fromStatus: from,
      toStatus: to,
      templateId,
      reason,
      actorType: actor.type,
      actorId: actor.type === "user" ? actor.id : null,
      createdAt: new Date(),
    },
  });
  return row as LeadStatusChange;
}

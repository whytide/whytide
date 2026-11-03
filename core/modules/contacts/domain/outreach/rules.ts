// The outreach status's rules (docs/concepts.md "Outreach status"), pure: the input of a change, who
// made it, and from which statuses Approve may move a lead.
import type { Principal } from "@whytide/platform";
import { z } from "zod";
import { code, id } from "../rules.ts";
import { IN_OUTREACH, OUTREACH_STATUSES, type OutreachStatus } from "./constants.ts";

/** Who changes a status: a user, by id, or the system, as nobody. */
export type StatusActor =
  | { readonly type: "user"; readonly id: string }
  | { readonly type: "system" };

export const recordStatusInput = z.strictObject({
  personId: id,
  to: z.enum(OUTREACH_STATUSES),
  /** A code, such as opted_out; never a value about the person. */
  reason: code.optional(),
  /** The campaign's template that moved the lead, for in_campaign and finished. */
  templateId: id.optional(),
  actor: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("user"), id }),
    z.strictObject({ type: z.literal("system") }),
  ]),
});

/** The run's principal as a change's actor: a person is a user; a service, the system. */
export function actorOf(principal: Principal): StatusActor {
  return principal.actorType === "human"
    ? { type: "user", id: principal.userId }
    : { type: "system" };
}

/**
 * Whether Approve may move a lead from `status`, before the never-contact check: from
 * pending_review, from approved again, and from suppressed when the lead was never in a campaign;
 * never from in_campaign, replied or finished (lead_in_outreach).
 */
export function approvableFrom(status: OutreachStatus, everInCampaign: boolean): boolean {
  if ((IN_OUTREACH as readonly OutreachStatus[]).includes(status)) return false;
  return status !== "suppressed" || !everInCampaign;
}

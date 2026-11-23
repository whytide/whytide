// GET …/qualification/leads/{personId}/snapshot (README.md "Routes"), inside the request's tenant
// run: the lead's current snapshot and its intent, under the permission of contacts' lead routes,
// leads.read, which contacts declares and the lead page holds already. snapshotAnswer is the
// member's verdict routes' answer too (member-verdict.controller.ts).
import { Controller, Get, Param, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors, permissions } from "@whytide/contacts";
import {
  getSnapshot,
  type Snapshot,
  type SnapshotIntent,
  type SnapshotVerdict,
} from "../domain/score/get-snapshot.ts";
import { errors } from "../errors.ts";
import { type SnapshotResponse, snapshotParams, snapshotResponse } from "../schemas/snapshot.ts";

@Controller("leads")
export class SnapshotController {
  @Get(":personId/snapshot")
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The lead's current snapshot: the audience it was judged against, a verdict per criterion, the one that counts beside the model's and a member's, with evidence, weight and points, the disqualifiers and the model's summary; the lead's intent, priority and tier with each signal's share, or null",
    params: snapshotParams,
    response: snapshotResponse,
    errors: [errors.score_snapshot_not_found, contactsErrors.lead_not_found],
  })
  async get(@Param("personId") personId: string): Promise<SnapshotResponse> {
    return snapshotAnswer(await getSnapshot(personId));
  }
}

/** The snapshot as the routes answer it, its times as ISO strings: the read's and the edits'. */
export function snapshotAnswer(read: Snapshot): SnapshotResponse {
  const { scoredAt, disqualifiers, verdicts, intent, audience, ...snapshot } = read;
  return {
    ...snapshot,
    audience: audience && { ...audience },
    disqualifiers: [...disqualifiers],
    verdicts: verdicts.map(verdictOf),
    scoredAt: scoredAt.toISOString(),
    intent: intent && intentOf(intent),
  };
}

/** A verdict with its member's time as an ISO string. */
function verdictOf({ member, ...verdict }: SnapshotVerdict): SnapshotResponse["verdicts"][number] {
  return { ...verdict, member: member && { ...member, setAt: member.setAt.toISOString() } };
}

/** The intent with its times as ISO strings. */
function intentOf(intent: SnapshotIntent): NonNullable<SnapshotResponse["intent"]> {
  const { whyNow, boostUntil, breakdown, computedAt, ...scores } = intent;
  return {
    ...scores,
    whyNow: whyNow && { ...whyNow },
    boostUntil: boostUntil?.toISOString() ?? null,
    breakdown: breakdown.map((share) => ({ ...share })),
    computedAt: computedAt.toISOString(),
  };
}

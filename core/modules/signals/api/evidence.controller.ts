// GET …/signals/leads/{personId}/evidence (README.md "API"), inside the request's tenant run: the
// person's events and their evidence for the lead page, with their sources' labels and the lead's
// attribution, under the permission of contacts' lead routes, leads.read, which the lead page holds
// already (as qualification's snapshot route does).
import { Controller, Get, Param, SetMetadata } from "@nestjs/common";
import { errors as contactsErrors, permissions } from "@whytide/contacts";
import { attributionOf } from "../domain/attribution.ts";
import { listEvidence, type SignalEvent } from "../domain/evidence.ts";
import { type EvidenceResponse, evidenceParams, evidenceResponse } from "../schemas/evidence.ts";

@Controller("leads")
export class EvidenceController {
  @Get(":personId/evidence")
  // The api host's @Permission and @ApiRoute, which a module cannot import (core/apps/api README).
  @SetMetadata("whytide:permission", permissions["leads.read"])
  @SetMetadata("whytide:api-route", {
    summary:
      "The person's signal events, newest first, each with its evidence, and the attribution",
    params: evidenceParams,
    response: evidenceResponse,
    errors: [contactsErrors.person_not_found],
  })
  async list(@Param("personId") personId: string): Promise<EvidenceResponse> {
    const events = await listEvidence(personId);
    const sourceIds = events.map(({ sourceId }) => sourceId);
    const { attribution, labels } = await attributionOf(personId, sourceIds);
    return { events: events.map((event) => toEvent(event, labels)), attribution };
  }
}

function toEvent(
  event: SignalEvent,
  labels: ReadonlyMap<string, string>,
): EvidenceResponse["events"][number] {
  const { id, kind, sourceId, runId, occurredAt } = event;
  const found = event.evidence;
  const evidence = found && {
    url: found.url,
    excerpt: found.excerpt,
    commentText: found.commentText,
    reaction: found.reaction,
    author: found.author,
    capturedAt: found.capturedAt.toISOString(),
    reducedAt: found.reducedAt?.toISOString() ?? null,
  };
  return {
    id,
    kind,
    sourceId,
    sourceLabel: (sourceId && labels.get(sourceId)) ?? null,
    runId,
    occurredAt: occurredAt.toISOString(),
    evidence: evidence ?? null,
  };
}

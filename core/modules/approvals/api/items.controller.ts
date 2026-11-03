// The queue's routes (README.md "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/approvals: thin handlers over domain/items/, inside the request's
// tenant run. A module cannot import the host, so each route sets the host's metadata itself: its
// permission, its @ApiRoute and, for a decision, @Idempotent(), so a double press with one
// Idempotency-Key acts once (core/apps/api/README.md "Permissions", "Request protection").
import { Body, Controller, Get, HttpCode, Param, Post, SetMetadata } from "@nestjs/common";
import type { StepDraft } from "@whytide/messaging";
import { errors as messagingErrors } from "@whytide/messaging";
import { currentTenant } from "@whytide/platform";
import { approve, skip } from "../domain/items/decide.ts";
import { describeItem, type QueueItem, readQueue } from "../domain/items/queue.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ApproveBody,
  approveBody,
  type ItemResponse,
  type ItemsResponse,
  itemParams,
  itemResponse,
  itemsResponse,
} from "../schemas/items.ts";

const read = SetMetadata("whytide:permission", permissions["approvals.read"]);
const decide = SetMetadata("whytide:permission", permissions["approvals.decide"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const decisionErrors = [
  errors.approval_item_not_found,
  errors.approval_item_not_pending,
  errors.not_sender_owner,
];

@Controller("items")
export class ItemsController {
  @Get()
  @read
  @route({
    summary:
      "The queue: every pending item, overdue ones included, and every approved one whose step waits, by due time, each with its lead, draft, sender account, flags and whether the caller decides it; and the counts to approve and decided today",
    response: itemsResponse,
  })
  async list(): Promise<ItemsResponse> {
    const { items, counts } = await readQueue(currentTenant().principal);
    return { items: items.map(toResponse), counts };
  }

  @Post(":id/approve")
  @HttpCode(200)
  @decide
  @idempotent
  @route({
    summary:
      "Approves a pending item as the sender account's owner, with the text given or the draft's own, which passes the gates and is frozen; publishes approvals.item_decided",
    params: itemParams,
    body: approveBody,
    response: itemResponse,
    errors: [...decisionErrors, errors.approval_draft_pending, messagingErrors.draft_text_refused],
  })
  async approve(@Param("id") id: string, @Body() body: ApproveBody): Promise<ItemResponse> {
    const { principal } = currentTenant();
    return toResponse(await describeItem(await approve(id, body, principal), principal));
  }

  @Post(":id/skip")
  @HttpCode(200)
  @decide
  @idempotent
  @route({
    summary:
      "Skips a pending item as the sender account's owner: its step goes no further and its draft stays as it is; publishes approvals.item_decided",
    params: itemParams,
    response: itemResponse,
    errors: decisionErrors,
  })
  async skip(@Param("id") id: string): Promise<ItemResponse> {
    const { principal } = currentTenant();
    return toResponse(await describeItem(await skip(id, principal), principal));
  }
}

/** The answer: the times as ISO strings, the draft as messaging reads it. */
function toResponse(item: QueueItem): ItemResponse {
  const { id, status, stepKey, actionType, waitCode, stale, needsAttention } = item;
  const { lead, sender, canDecide } = item;
  return {
    ...{ id, status, stepKey, actionType, waitCode, stale, needsAttention, lead, sender },
    scheduledFor: item.scheduledFor.toISOString(),
    createdAt: item.createdAt.toISOString(),
    waitUntil: item.waitUntil?.toISOString() ?? null,
    draft: item.draft && draftResponse(item.draft),
    canDecide,
  };
}

function draftResponse(draft: StepDraft): NonNullable<ItemResponse["draft"]> {
  const gates = draft.gates.map(({ gate, issues }) => ({ gate, issues: [...issues] }));
  const { flagReasons, factIds, approvedAt } = draft;
  const lists = { gates, flagReasons: [...flagReasons], factIds: [...factIds] };
  return { ...draft, ...lists, approvedAt: approvedAt?.toISOString() ?? null };
}

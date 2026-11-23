// The Invites screen's routes (README.md "Invites"), identity's `api`, which the api host mounts under
// /v1/workspaces/:workspaceId/identity, each declaring identity.invite (Owner). The list and the
// revoke run in the request's tenant run. The invite declares whytide:own-runs: createInvite opens
// its own run, and the mail leaves after that run's commit, outside any, its outcome in the answer;
// so it is not @Idempotent(), whose record commits with the request's run, and a retry answers
// invite_exists for the open invite the first call made, sending nothing. A module cannot import the
// host, so each route sets the host's metadata itself: its permission and its @ApiRoute. The list
// answers the days settings.ts reads, for the screen; a summary names no configured value.
import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Module,
  Param,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import { AppError, currentTenant, type TenantContext } from "@whytide/platform";
import { now } from "../domain/clock.ts";
import {
  createInvite,
  type Invite,
  type ListedInvite,
  listInvites,
  revokeInvite,
} from "../domain/invites.ts";
import { mailInvite } from "../domain/mail.ts";
import { inviteState } from "../domain/rules.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CreateInviteBody,
  type CreateInviteResponse,
  createInviteBody,
  createInviteResponse,
  type InviteListResponse,
  type InviteResponse,
  inviteListResponse,
  inviteParams,
  inviteResponse,
} from "../schemas/invites.ts";
import { settings } from "../settings.ts";

const invite = SetMetadata("whytide:permission", permissions["identity.invite"]);
const idempotent = SetMetadata("whytide:idempotent", true);
const ownRuns = SetMetadata("whytide:own-runs", true);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("invites")
export class InvitesController {
  @Get()
  @invite
  @route({
    summary:
      "The workspace's invites not accepted, the latest made or renewed first, each open, expired or revoked, and the days an invite stays open",
    response: inviteListResponse,
  })
  async list(): Promise<InviteListResponse> {
    const ttlDays = settings.IDENTITY_INVITE_TTL_DAYS;
    return { invites: (await listInvites()).map(toResponse), ttlDays };
  }

  @Post()
  @invite
  @ownRuns
  @route({
    summary:
      "Invites an email as Owner or Member, or renews its expired, revoked or left invite, then mails it the Invitations page: sent, skipped while APP_PUBLIC_ORIGIN is empty, or failed with the port's code, the invite kept",
    body: createInviteBody,
    response: createInviteResponse,
    errors: [errors.identity_input_invalid, errors.invite_exists, errors.already_member],
  })
  async create(
    @Req() req: OwnRunsRequest,
    @Body() body: CreateInviteBody,
  ): Promise<CreateInviteResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    const { workspaceId, principal } = req.tenant;
    const made = await createInvite({ workspaceId, ...body, invitedBy: principal.userId });
    const { mailedAt, ...outcome } = await mailInvite(made);
    return { invite: toResponse(withState({ ...made, mailedAt })), ...outcome };
  }

  @Post(":id/revoke")
  @HttpCode(200)
  @invite
  @idempotent
  @route({
    summary:
      "Revokes an invite not accepted: it lets no one in from then on; a revoked one answers unchanged",
    params: inviteParams,
    response: inviteResponse,
    errors: [errors.invite_not_found, errors.invite_accepted],
  })
  async revoke(@Param("id") id: string): Promise<InviteResponse> {
    const revoked = await revokeInvite(id, currentTenant().principal.userId);
    return toResponse(withState(revoked));
  }
}

@Module({ controllers: [InvitesController] })
export class InvitesApi {}

/** The invite with its state now: open, expired or revoked, since an accepted one is not revoked. */
function withState(invite: Invite): ListedInvite {
  const state = inviteState(invite, now());
  if (state === "accepted") throw new AppError(errors.invite_accepted);
  return { ...invite, state };
}

function toResponse(invite: ListedInvite): InviteResponse {
  const { id, email, role, state, invitedBy, createdAt, expiresAt, mailedAt } = invite;
  return {
    id,
    email,
    role,
    state,
    invitedBy,
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    mailedAt: mailedAt?.toISOString() ?? null,
  };
}

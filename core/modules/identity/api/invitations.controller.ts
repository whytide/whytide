// The Invitations page's routes (README.md "Invites"), identity's `accountApi`, which the api host
// mounts under /v1 behind its principal guard only: a session, no workspace, no tenant run, no
// permission; the guard leaves the principal on the request (core/apps/api/README.md "Modules"). The
// caller's own open invites, read by their session's email, and the accept: the session proves the
// address, so no token is needed. The accept is not @Idempotent(), whose record needs a workspace's
// run: it is idempotent itself, a second accept answering the same workspace.
import {
  Controller,
  Get,
  HttpCode,
  Module,
  type OnApplicationShutdown,
  Param,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import type { Principal } from "@whytide/platform";
import { acceptInvite, invitationsOf } from "../domain/accept.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import {
  type AcceptResponse,
  acceptResponse,
  type InvitationResponse,
  invitationListResponse,
  inviteParams,
} from "../schemas/invites.ts";

/** What an account route reads of the request: the principal the host's guard resolved. */
type AccountRequest = { readonly principal?: Principal };
// The api host's @ApiRoute, which a module cannot import; the host adds the 401.
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

/** The host's guard answered 401 without a session, so a missing principal is a host bug: 500. */
function userOf(req: AccountRequest): string {
  if (req.principal === undefined) throw new Error("no principal on an account route");
  return req.principal.userId;
}

@Controller("invitations")
export class InvitationsController {
  @Get()
  @route({
    summary:
      "The caller's own open invites, by their session's email, oldest first, with the workspace's and the inviter's names",
    response: invitationListResponse,
  })
  async list(@Req() req: AccountRequest): Promise<{ invitations: InvitationResponse[] }> {
    const invitations = await invitationsOf(userOf(req));
    return {
      invitations: invitations.map(({ expiresAt, ...invitation }) => ({
        ...invitation,
        expiresAt: expiresAt.toISOString(),
      })),
    };
  }

  @Post(":id/accept")
  @HttpCode(200)
  @route({
    summary:
      "Accepts the caller's own open invite: a membership with its role, and where to go; a second accept answers the same workspace",
    params: inviteParams,
    response: acceptResponse,
    errors: [errors.invite_not_found],
  })
  async accept(@Req() req: AccountRequest, @Param("id") id: string): Promise<AcceptResponse> {
    return acceptInvite({ inviteId: id, userId: userOf(req) });
  }
}

@Module({ controllers: [InvitationsController] })
export class InvitationsApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

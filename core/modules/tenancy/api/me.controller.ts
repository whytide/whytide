// GET /v1/me (README.md "GET /v1/me"): the signed-in user, the workspaces they belong to and the
// feedback link (settings.ts FEEDBACK_URL). The api host mounts `accountApi` under /v1 behind its
// principal guard only, outside the workspaces: any principal, no tenant run, no permission; the
// guard leaves the principal on the request (core/apps/api/README.md "Modules").
import {
  Controller,
  Get,
  Module,
  type OnApplicationShutdown,
  Req,
  SetMetadata,
} from "@nestjs/common";
import { AppError, type Principal } from "@whytide/platform";
import { findUser, listMemberships } from "../domain/commands.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { type MeResponse, meResponse } from "../schemas/me.ts";
import { settings } from "../settings.ts";

/** What an account route reads of the request: the principal the host's guard resolved. */
type AccountRequest = { readonly principal?: Principal };

@Controller("me")
export class MeController {
  @Get()
  // The api host's @ApiRoute, which a module cannot import: it documents the route in the OpenAPI
  // document (core/apps/api/README.md "OpenAPI and the client"); the host adds the 401.
  @SetMetadata("whytide:api-route", {
    summary: "The signed-in user and the workspaces they belong to, with their role in each",
    response: meResponse,
    errors: [errors.user_not_found],
  })
  async me(@Req() req: AccountRequest): Promise<MeResponse> {
    // The host's guard answered 401 without a session, so a missing principal is a host bug: 500.
    if (req.principal === undefined) throw new Error("no principal on an account route");
    const user = await findUser(req.principal.userId);
    if (user === null) throw new AppError(errors.user_not_found);
    const memberships = await listMemberships(user.id);
    const { id, email, displayName, locale } = user;
    return {
      user: { id, email, displayName, locale },
      memberships: memberships.map(({ workspaceId, slug, name, organizationName, role }) => ({
        workspaceId,
        slug,
        name,
        organizationName,
        role,
      })),
      feedbackUrl: settings.FEEDBACK_URL ?? null,
    };
  }
}

@Module({ controllers: [MeController] })
export class AccountApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

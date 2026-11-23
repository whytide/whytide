// The mailboxes routes (README.md "API"), which the api host mounts under
// /v1/workspaces/:workspaceId/email: thin handlers over domain/, inside the request's tenant run, but
// the callback: it calls the provider's code exchange, which no run waits on, so it declares
// whytide:own-runs and opens its own (core/apps/api/README.md "Request protection"). A module cannot
// import the host, so each route sets the host's metadata itself: its permission and its @ApiRoute.
import type { IncomingMessage } from "node:http";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  type OnApplicationShutdown,
  Param,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant, type TenantContext } from "@whytide/platform";
import { finishConnect, startConnect } from "../domain/connect.ts";
import { CALLBACK_PATH } from "../domain/constants.ts";
import { disconnectOwn, listMailboxes, type Mailbox } from "../domain/mailboxes.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CallbackBody,
  type ConnectBody,
  callbackBody,
  connectBody,
  connectResponse,
  type MailboxResponse,
  mailboxListResponse,
  mailboxParams,
  mailboxResponse,
} from "../schemas/mailboxes.ts";

const can = (action: keyof typeof permissions) =>
  SetMetadata("whytide:permission", permissions[action]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const ownRuns = SetMetadata("whytide:own-runs", true);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("mailboxes")
export class MailboxesController {
  @Post("connect")
  @HttpCode(200)
  @can("email.connect")
  @route({
    summary:
      "The provider's consent address for the signed-in member's own mailbox, with a state that lives 10 minutes",
    body: connectBody,
    response: connectResponse,
    errors: [errors.mailbox_exists, errors.mailbox_time_zone_invalid],
  })
  connect(@Body() body: ConnectBody): Promise<{ url: string }> {
    return startConnect({ ...body, redirectUri: callbackUri() });
  }

  @Post("callback")
  @HttpCode(200)
  @can("email.connect")
  @ownRuns
  @route({
    summary:
      "The consent's return: claims the state, exchanges the code and stores the mailbox the exchange proves, connected; publishes email.mailbox_connected",
    body: callbackBody,
    response: mailboxResponse,
    errors: [
      errors.connect_state_invalid,
      errors.mailbox_consent_incomplete,
      errors.mailbox_in_use,
      errors.mailbox_exists,
      errors.mailbox_connect_failed,
    ],
  })
  async callback(@Req() req: OwnRunsRequest, @Body() body: CallbackBody): Promise<MailboxResponse> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    const stored = await finishConnect(req.tenant, { ...body, redirectUri: callbackUri() });
    return toResponse(stored, req.tenant.principal.userId);
  }

  @Get()
  @can("email.read")
  @route({
    summary:
      "The signed-in member's mailboxes, or every mailbox of the workspace for a holder of email.manage, oldest first",
    response: mailboxListResponse,
  })
  async list(): Promise<{ mailboxes: MailboxResponse[] }> {
    const userId = currentTenant().principal.userId;
    return { mailboxes: (await listMailboxes()).map((mailbox) => toResponse(mailbox, userId)) };
  }

  @Delete(":mailboxId")
  @HttpCode(204)
  @can("email.connect")
  @route({
    summary:
      "Disconnects the signed-in member's own mailbox at once; the worker then revokes and deletes its tokens; publishes email.mailbox_disconnected",
    params: mailboxParams,
    errors: [errors.email_mailbox_not_found, errors.not_mailbox_owner],
  })
  async remove(@Param("mailboxId") mailboxId: string): Promise<void> {
    await disconnectOwn(mailboxId);
  }
}

@Module({ controllers: [MailboxesController] })
export class EmailApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

/**
 * The address the provider sends the browser back to, fixed outside the workspaces: the web's
 * origin, APP_PUBLIC_ORIGIN (the api's variable), or the web's development server's when it is
 * unset under development.
 */
function callbackUri(): string {
  const origin = process.env.APP_PUBLIC_ORIGIN || process.env.WEB_DEV_ORIGIN;
  if (!origin) throw new Error("APP_PUBLIC_ORIGIN is not set: the consent needs the app's origin");
  return `${origin.replace(/\/+$/, "")}${CALLBACK_PATH}`;
}

function toResponse(mailbox: Mailbox, userId: string): MailboxResponse {
  const { id, ownerUserId, provider, emailAddress, displayName, status } = mailbox;
  const { disconnectedReason, isFreeConsumer, timeZone, connectedAt, disconnectedAt } = mailbox;
  return {
    id,
    ownerUserId,
    mine: ownerUserId === userId,
    provider,
    emailAddress,
    displayName,
    status,
    disconnectedReason,
    isFreeConsumer,
    timeZone,
    connectedAt: connectedAt.toISOString(),
    disconnectedAt: disconnectedAt?.toISOString() ?? null,
  };
}

// The accounts routes (README.md "API"), which the api host mounts under
// /v1/workspaces/:workspaceId/linkedin: thin handlers over domain/accounts.ts, inside the request's
// tenant run, but connect: it calls the provider, which no run waits on, so it declares
// whytide:own-runs and opens its own (core/apps/api/README.md "Request protection"). A module cannot
// import the host, so each route sets the host's metadata itself: its permission and its @ApiRoute
// ("Permissions", "OpenAPI and the client"). The webhook is api/webhooks.ts, mounted by the host.
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
  Patch,
  Post,
  Req,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant, can as decide, type TenantContext } from "@whytide/platform";
import {
  disconnect,
  listAccounts,
  requestRefresh,
  type SenderAccount,
  startConnect,
  updateSettings,
} from "../domain/accounts.ts";
import { readUsage } from "../domain/quota/reservations.ts";
import { disconnectClient } from "../domain/store.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type AccountResponse,
  accountListResponse,
  accountParams,
  accountResponse,
  type ConnectBody,
  connectBody,
  connectResponse,
  type UpdateAccountBody,
  updateAccountBody,
} from "../schemas/accounts.ts";
import { type UsageResponse, usageResponse } from "../schemas/quota.ts";

const can = (action: keyof typeof permissions) =>
  SetMetadata("whytide:permission", permissions[action]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const ownRuns = SetMetadata("whytide:own-runs", true);
const idempotent = SetMetadata("whytide:idempotent", true);
/** The request of an own-runs route: the host leaves the tenant on it, read-only. */
type OwnRunsRequest = IncomingMessage & { readonly tenant?: TenantContext };

@Controller("accounts")
export class AccountsController {
  @Post("connect")
  @HttpCode(200)
  @can("linkedin.connect")
  @ownRuns
  @route({
    summary:
      "The provider's hosted link for the signed-in user's own account, after the risk disclosure; the account waits as pending for the provider's webhook",
    body: connectBody,
    response: connectResponse,
    errors: [
      errors.disclosure_required,
      errors.working_hours_invalid,
      errors.sender_account_exists,
    ],
  })
  connect(@Req() req: OwnRunsRequest, @Body() body: ConnectBody): Promise<{ url: string }> {
    // The host sets it on an own-runs route: a missing one is a host bug, 500.
    if (req.tenant === undefined) throw new Error("no tenant on an own-runs route");
    return startConnect(req.tenant, { ...body, returnTo: returnTo(req.tenant.workspaceId) });
  }

  @Get()
  @can("linkedin.read")
  @route({
    summary: "The workspace's sender accounts, oldest first, with their status and working hours",
    response: accountListResponse,
  })
  async list(): Promise<{ accounts: AccountResponse[] }> {
    return { accounts: (await listAccounts()).map(toResponse) };
  }

  @Get(":id/usage")
  @can("linkedin.read")
  @route({
    summary:
      "An account's reads today, reserved and made, over its daily cap, and whether its working hours are open now, in its time zone",
    params: accountParams,
    response: usageResponse,
    errors: [errors.sender_account_not_found],
  })
  async usage(@Param("id") id: string): Promise<UsageResponse> {
    const usage = await readUsage(id);
    return { ...usage, nextWindowAt: usage.nextWindowAt.toISOString() };
  }

  @Patch(":id")
  @can("linkedin.manage")
  @route({
    summary: "Relabels an account or changes its time zone, working hours or daily read cap",
    params: accountParams,
    body: updateAccountBody,
    response: accountResponse,
    errors: [
      errors.sender_account_not_found,
      errors.working_hours_invalid,
      errors.read_cap_invalid,
    ],
  })
  async update(@Param("id") id: string, @Body() body: UpdateAccountBody): Promise<AccountResponse> {
    return toResponse(await updateSettings(id, body));
  }

  @Post(":id/refresh")
  @HttpCode(202)
  @can("linkedin.manage")
  @idempotent
  @route({
    summary:
      "Asks the worker for the account's status at the provider now; the account as it stands, its status changing once the worker has it",
    params: accountParams,
    response: accountResponse,
    errors: [errors.sender_account_not_found],
  })
  async refresh(@Param("id") id: string): Promise<AccountResponse> {
    return toResponse(await requestRefresh(id));
  }

  @Delete(":id")
  @HttpCode(204)
  @can("linkedin.manage")
  @route({
    summary:
      "Disconnects an account: deletes its reference, keeps it as disconnected; publishes linkedin.sender_account_disconnected",
    params: accountParams,
    errors: [errors.sender_account_not_found],
  })
  async remove(@Param("id") id: string): Promise<void> {
    await disconnect(id);
  }
}

@Module({ controllers: [AccountsController] })
export class LinkedinApi implements OnApplicationShutdown {
  /** Once the api's server has closed and its requests have ended, the module's own client ends. */
  async onApplicationShutdown(): Promise<void> {
    await disconnectClient();
  }
}

/**
 * The screen the provider sends the browser back to: the web app's origin, APP_PUBLIC_ORIGIN (the
 * api's variable), or the web's development server's when it is unset under development.
 */
function returnTo(workspaceId: string): string {
  const origin = process.env.APP_PUBLIC_ORIGIN || process.env.WEB_DEV_ORIGIN;
  if (!origin)
    throw new Error("APP_PUBLIC_ORIGIN is not set: the hosted link needs the app's origin");
  return `${origin.replace(/\/+$/, "")}/w/${encodeURIComponent(workspaceId)}/linkedin`;
}

function toResponse(account: SenderAccount): AccountResponse {
  const { id, label, status, timeZone, workingHours, dailyReadCap, ownerUserId } = account;
  const { principal, workspaceId } = currentTenant();
  const mine = ownerUserId === principal.userId;
  // The one permission function (platform README "Principal and permissions"), as the guard asks it.
  const manage = decide(principal, permissions["linkedin.manage"], { workspaceId });
  return {
    id,
    label,
    status,
    timeZone,
    workingHours: { ...workingHours, days: [...workingHours.days] },
    dailyReadCap,
    mine,
    canManage: manage === "allow",
  };
}

// The accounts routes (README.md "API"), which the api host mounts under
// /v1/workspaces/:workspaceId/linkedin: thin handlers over domain/accounts.ts, the pause over
// domain/controls/, the disclosure over domain/disclosure/ and the health and the owner's resume over
// domain/health/resume.ts, inside the request's tenant run, but
// connect: it calls the provider, which no run waits on, so it declares whytide:own-runs and opens
// its own (core/apps/api/README.md "Request protection"). A module cannot import the host, so each
// route sets the host's metadata itself: its permission and its @ApiRoute ("Permissions", "OpenAPI
// and the client"). The controls routes are api/controls.controller.ts; the webhook is
// api/webhooks.ts, mounted by the host.
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
import { linkedinPort } from "@whytide/providers";
import {
  disconnect,
  listAccounts,
  requestRefresh,
  type SenderAccount,
  startConnect,
  updateSettings,
} from "../domain/accounts.ts";
import { now } from "../domain/clock.ts";
import { pauseAccount, unpauseAccount } from "../domain/controls/controls.ts";
import { acceptDisclosure, sendingDisclosureRequired } from "../domain/disclosure/disclosure.ts";
import { type HealthView, readHealth, resumeAccount } from "../domain/health/resume.ts";
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
  type DisclosureBody,
  disclosureBody,
  type UpdateAccountBody,
  updateAccountBody,
} from "../schemas/accounts.ts";
import { type HealthResponse, healthResponse, resumeBody } from "../schemas/health.ts";
import { type UsageResponse, usageResponse } from "../schemas/quota.ts";
import { ControlsController, can, route } from "./controls.controller.ts";

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
      "The provider's hosted link for the signed-in user's own account, after the risk disclosure and the personal-account confirmation; the account waits as pending for the provider's webhook",
    body: connectBody,
    response: connectResponse,
    errors: [
      errors.disclosure_required,
      errors.personal_account_required,
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
      "An account's day in its time zone: its reads, connection requests, messages and withdrawals, reserved and made, against their limits, the week's connection requests, the 200 actions, and whether its working hours are open now",
    params: accountParams,
    response: usageResponse,
    errors: [errors.sender_account_not_found],
  })
  async usage(@Param("id") id: string): Promise<UsageResponse> {
    const usage = await readUsage(id);
    return { ...usage, nextWindowAt: usage.nextWindowAt.toISOString() };
  }

  @Get(":id/health")
  @can("linkedin.read")
  @route({
    summary:
      "An account's health: its state, what moved it there and since when, the cool-down's end, its status and when the worker checked it, whether the caller may resume it and else why not, the fleet breaker, its pending invitations, its acceptance rate and its latest health events",
    params: accountParams,
    response: healthResponse,
    errors: [errors.sender_account_not_found],
  })
  async health(@Param("id") id: string): Promise<HealthResponse> {
    return toHealth(await readHealth(currentTenant().principal.userId, id, now()));
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

  @Post(":id/pause")
  @HttpCode(200)
  @can("linkedin.manage")
  @idempotent
  @route({
    summary:
      "Pauses the account: no LinkedIn action through it from the next reservation, reads included; a paused account, the operator's pause too, stays as it is; the account",
    params: accountParams,
    response: accountResponse,
    errors: [errors.sender_account_not_found],
  })
  async pause(@Param("id") id: string): Promise<AccountResponse> {
    return toResponse(await pauseAccount(id, currentTenant().principal.userId));
  }

  @Post(":id/unpause")
  @HttpCode(200)
  @can("linkedin.manage")
  @idempotent
  @route({
    summary:
      "Resumes the account, by its owner only; the operator's pause only the operator lifts; an account not paused stays as it is; the account",
    params: accountParams,
    response: accountResponse,
    errors: [errors.sender_account_not_found, errors.not_account_owner, errors.stopped_by_operator],
  })
  async unpause(@Param("id") id: string): Promise<AccountResponse> {
    return toResponse(await unpauseAccount(id, currentTenant().principal.userId));
  }

  @Post(":id/resume")
  @HttpCode(200)
  @can("linkedin.manage")
  @idempotent
  @route({
    summary:
      "The owner resumes the account after a restriction's or a checkpoint's cool-down, once the worker has found it connected since, at half its targets; the fleet breaker stays as it is; the account's health",
    params: accountParams,
    body: resumeBody,
    response: healthResponse,
    errors: [
      errors.sender_account_not_found,
      errors.not_account_owner,
      errors.account_not_paused,
      errors.cooldown_active,
      linkedinPort.errors.linkedin_account_disconnected,
      errors.reconnect_required,
      errors.status_check_required,
    ],
  })
  async resume(@Param("id") id: string): Promise<HealthResponse> {
    const userId = currentTenant().principal.userId;
    const at = now();
    await resumeAccount(userId, id, at);
    return toHealth(await readHealth(userId, id, at));
  }

  @Post(":id/disclosure")
  @HttpCode(200)
  @can("linkedin.connect")
  @idempotent
  @route({
    summary:
      "The owner accepts the risk disclosure for sending and confirms the account is their own personal one; a repeat changes nothing; the account",
    params: accountParams,
    body: disclosureBody,
    response: accountResponse,
    errors: [
      errors.sender_account_not_found,
      errors.not_account_owner,
      errors.disclosure_version_invalid,
      errors.personal_account_required,
    ],
  })
  async disclosure(
    @Param("id") id: string,
    @Body() body: DisclosureBody,
  ): Promise<AccountResponse> {
    return toResponse(await acceptDisclosure(id, currentTenant().principal.userId, body));
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

@Module({ controllers: [AccountsController, ControlsController] })
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

/** The health view with its times in ISO. */
function toHealth(view: HealthView): HealthResponse {
  const iso = (time: Date | null) => time?.toISOString() ?? null;
  return {
    ...view,
    since: iso(view.since),
    pausedUntil: iso(view.pausedUntil),
    statusCheckedAt: iso(view.statusCheckedAt),
    pendingInvitesCheckedAt: iso(view.pendingInvitesCheckedAt),
    events: view.events.map((event) => ({ ...event, at: event.at.toISOString() })),
  };
}

function toResponse(account: SenderAccount): AccountResponse {
  const { id, label, status, timeZone, workingHours, dailyReadCap, ownerUserId } = account;
  const { killSwitch, killSwitchSource } = account;
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
    paused: killSwitch,
    pausedBy: killSwitchSource,
    disclosureVersion: account.disclosureVersion,
    sendingDisclosureRequired: sendingDisclosureRequired(account),
  };
}

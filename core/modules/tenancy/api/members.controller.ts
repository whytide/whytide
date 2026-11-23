// The members routes (README.md "Members"), tenancy's `api`, which the api host mounts under
// /v1/workspaces/:workspaceId/tenancy: thin handlers over domain/, inside the request's tenant run,
// where the commands read and lock the workspace's memberships. The caller is the run's principal.
// A module cannot import the host, so each route sets the host's metadata itself: its permission
// and its @ApiRoute.
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Module,
  Param,
  Patch,
  SetMetadata,
} from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import { changeRole, listMembers, type Member, removeMember } from "../domain/commands.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ChangeRoleBody,
  changeRoleBody,
  type MemberResponse,
  memberListResponse,
  memberParams,
  memberResponse,
} from "../schemas/members.ts";

const can = (action: keyof typeof permissions) =>
  SetMetadata("whytide:permission", permissions[action]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);
const refusals = [errors.membership_not_found, errors.member_is_self, errors.last_owner];

@Controller("members")
export class MembersController {
  @Get()
  @can("workspace.read")
  @route({
    summary:
      "The workspace's active members with their email, name and role, Owners first, then by name; the caller's own row is isSelf",
    response: memberListResponse,
  })
  async list(): Promise<{ members: MemberResponse[] }> {
    const caller = currentTenant().principal.userId;
    return { members: (await listMembers()).map((member) => toResponse(member, caller)) };
  }

  @Patch(":membershipId")
  @can("members.manage")
  @route({
    summary:
      "Changes another member's role between Owner and Member; the same role answers the member unchanged",
    params: memberParams,
    body: changeRoleBody,
    response: memberResponse,
    errors: refusals,
  })
  async update(
    @Param("membershipId") membershipId: string,
    @Body() { role }: ChangeRoleBody,
  ): Promise<MemberResponse> {
    const changedBy = currentTenant().principal.userId;
    return toResponse(await changeRole({ membershipId, role, changedBy }), changedBy);
  }

  @Delete(":membershipId")
  @HttpCode(204)
  @can("members.manage")
  @route({
    summary:
      "Removes another member: the workspace refuses them from their next request; publishes tenancy.member_removed once, and a removed member answers 204 again",
    params: memberParams,
    errors: refusals,
  })
  async remove(@Param("membershipId") membershipId: string): Promise<void> {
    await removeMember({ membershipId, removedBy: currentTenant().principal.userId });
  }
}

@Module({ controllers: [MembersController] })
export class MembersApi {}

function toResponse(member: Member, caller: string): MemberResponse {
  const { joinedAt, ...fields } = member;
  return { ...fields, joinedAt: joinedAt.toISOString(), isSelf: member.userId === caller };
}

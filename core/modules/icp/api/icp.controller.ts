// The ICP's routes (README "Routes"), which the api host mounts under
// /v1/workspaces/:workspaceId/icp: each handler runs in the request's tenant run, so the commands
// read and write through its transaction. A module cannot import the host: a route writes the host's
// metadata itself, its permission and its @ApiRoute (core/apps/api/README.md "Modules",
// "Permissions", "OpenAPI and the client").
import { Body, Controller, Get, Module, Put, SetMetadata } from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import { getCriteria, getIcp, type Icp, saveCriteria, saveIcp } from "../domain/commands.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type CriteriaBody,
  type CriteriaResponse,
  criteriaBody,
  criteriaResponse,
  type IcpBody,
  type IcpResponse,
  icpBody,
  icpResponse,
} from "../schemas/icp.ts";

/** The codes of a value off a closed list (domain/rules.ts). */
const listErrors = [
  errors.icp_unknown_seniority,
  errors.icp_unknown_size_range,
  errors.icp_unknown_country,
];

@Controller()
export class IcpController {
  @Get()
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The workspace's ICP; the first read creates it empty, with its six criteria",
    response: icpResponse,
  })
  async readIcp(): Promise<IcpResponse> {
    return answer(await getIcp(currentTenant().workspaceId));
  }

  @Put()
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the ICP; a targeting change moves its version and publishes icp.updated",
    body: icpBody,
    response: icpResponse,
    errors: listErrors,
  })
  async writeIcp(@Body() body: IcpBody): Promise<IcpResponse> {
    return answer(await saveIcp(body));
  }

  @Get("criteria")
  @SetMetadata("whytide:permission", permissions["icp.read"])
  @SetMetadata("whytide:api-route", {
    summary: "The ICP's six criteria with their weights, must flags and enabled flags",
    response: criteriaResponse,
  })
  async readCriteria(): Promise<CriteriaResponse> {
    return { criteria: await getCriteria(currentTenant().workspaceId) };
  }

  @Put("criteria")
  @SetMetadata("whytide:permission", permissions["icp.write"])
  @SetMetadata("whytide:api-route", {
    summary: "Saves the six criteria; their weights sum to 100",
    body: criteriaBody,
    response: criteriaResponse,
    errors: [errors.icp_weights_must_sum_100],
  })
  async writeCriteria(@Body() body: CriteriaBody): Promise<CriteriaResponse> {
    return { criteria: await saveCriteria(body.criteria) };
  }
}

@Module({ controllers: [IcpController] })
export class IcpApi {}

function answer(icp: Icp): IcpResponse {
  return { ...icp, updatedAt: icp.updatedAt.toISOString() };
}

// The controls routes (README.md "API"), mounted with the accounts routes under
// /v1/workspaces/:workspaceId/linkedin: the platform's switches and the workspace's "Stop
// everything", read and set through domain/controls/ inside the request's tenant run. Setting the
// stop takes no Idempotency-Key: it sets a state, so a repeat changes nothing. The host's metadata
// helpers, which the accounts routes use too.
import { Body, Controller, Get, Put, SetMetadata } from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import { readControls, setWorkspaceStop } from "../domain/controls/controls.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type ControlsBody,
  type ControlsResponse,
  controlsBody,
  controlsResponse,
} from "../schemas/controls.ts";

export const can = (action: keyof typeof permissions) =>
  SetMetadata("whytide:permission", permissions[action]);
export const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller("controls")
export class ControlsController {
  @Get()
  @can("linkedin.read")
  @route({
    summary:
      "The platform's switches (sending open, every action stopped, invites paused) and the workspace's stop with who holds it",
    response: controlsResponse,
  })
  read(): Promise<ControlsResponse> {
    return readControls();
  }

  @Put()
  @can("linkedin.manage")
  @route({
    summary:
      "Stops every LinkedIn action of the workspace, reads included, from the next reservation, or lifts the tester's stop; the operator's stop only the operator lifts",
    body: controlsBody,
    response: controlsResponse,
    errors: [errors.stopped_by_operator],
  })
  write(@Body() body: ControlsBody): Promise<ControlsResponse> {
    return setWorkspaceStop(body.stopped, currentTenant().principal);
  }
}

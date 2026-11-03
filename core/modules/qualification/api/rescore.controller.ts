// The re-score's route (README "The re-score"), which the api host mounts under
// /v1/workspaces/:workspaceId/qualification: the handler runs in the request's tenant run, so the
// request is written in it. A module cannot import the host: the route writes the host's metadata
// itself, its permission and its @ApiRoute (core/apps/api/README.md "Modules", "OpenAPI and the client").
import { Body, Controller, HttpCode, Module, Post, SetMetadata } from "@nestjs/common";
import { requestRescore } from "../domain/rescore.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  type RescoreBody,
  type RescoreResponse,
  rescoreBody,
  rescoreResponse,
} from "../schemas/rescore.ts";
import { GoldenSetController } from "./golden-set.controller.ts";
import { SnapshotController } from "./snapshot.controller.ts";

@Controller("rescore")
export class RescoreController {
  @Post()
  @HttpCode(202)
  @SetMetadata("whytide:permission", permissions["qualification.rescore"])
  @SetMetadata("whytide:idempotent", true)
  @SetMetadata("whytide:api-route", {
    summary: "Re-scores the scored leads, or the named persons', from their stored verdicts",
    body: rescoreBody,
    response: rescoreResponse,
    errors: [errors.qualification_input_invalid],
  })
  async rescore(@Body() body: RescoreBody): Promise<RescoreResponse> {
    return requestRescore(body);
  }
}

// The module's routes: the re-score, the lead page's snapshot read (snapshot.controller.ts) and the
// golden set (golden-set.controller.ts).
@Module({ controllers: [RescoreController, SnapshotController, GoldenSetController] })
export class QualificationApi {}

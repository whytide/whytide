// `api`, the NestJS module the api host mounts under /v1/workspaces/:workspaceId/contacts
// (core/apps/api/README.md "Modules"): the person routes, the lead routes, the review routes, the
// export and the never-contact list.
import { Module } from "@nestjs/common";
import { ExportsController } from "./exports.controller.ts";
import { LeadsController } from "./leads.controller.ts";
import { PersonsController } from "./persons.controller.ts";
import { ReviewsController } from "./reviews.controller.ts";
import { SuppressionController } from "./suppression.controller.ts";

@Module({
  controllers: [
    PersonsController,
    LeadsController,
    ReviewsController,
    ExportsController,
    SuppressionController,
  ],
})
export class ContactsApi {}

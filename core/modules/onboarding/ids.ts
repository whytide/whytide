// The id prefixes of onboarding (core/packages/platform/README.md "Ids"): its tables' rows and the
// run of a Draft, which the record and the workflow's input carry.
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  ck: "company_knowledge",
  page: "website_page",
  cdoc: "company_document",
  drun: "draft_run",
});

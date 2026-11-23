// The id prefixes of enrichment's tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  erun: "enrichment_run",
  susage: "source_usage",
  cp: "contact_point",
  enr: "enrichment_request",
  ecache: "enrichment_cache_entry",
  eds: "email_domain_status",
});

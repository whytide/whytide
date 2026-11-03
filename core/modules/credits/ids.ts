// The id prefixes of credits' six tables (core/packages/platform/README.md "Ids"). The `sub`, `grant`
// and `bal` ids are made in SQL too, by credits_new_id of the migration, in the same format.
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  plan: "plan",
  sub: "subscription",
  grant: "credit_grant",
  usage: "credit_usage",
  bal: "credit_balance",
  pl: "price_list_entry",
});

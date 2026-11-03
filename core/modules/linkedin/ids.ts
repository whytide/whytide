// The id prefixes of linkedin's tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  sac: "sender_account",
  squ: "sender_quota_usage",
  sqr: "sender_quota_reservation",
  sal: "sender_action_log",
});

// The id prefixes of linkedin's tables (core/packages/platform/README.md "Ids").
import { defineIds } from "@whytide/platform";

export const ids = defineIds({
  sac: "sender_account",
  squ: "sender_quota_usage",
  sqr: "sender_quota_reservation",
  sal: "sender_action_log",
  sor: "sender_outreach",
  ler: "linkedin_event_receipt",
  lpc: "linkedin_platform_control",
  lwc: "linkedin_workspace_control",
  lce: "linkedin_control_event",
  she: "sender_health_event",
});

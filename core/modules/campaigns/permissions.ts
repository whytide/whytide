// The permission actions this module declares; platform assembles them at start
// (docs/rules/coding.md §3). campaigns.read guards the enrollments route, the counts route, the
// funnel's and the campaigns' (README.md "Routes"); campaigns.write every write of a campaign and the
// pause and resume routes of an enrollment (gamma-p3-060), for every role; campaigns.manage writes
// every campaign, which the commands check on the row, and shows every campaign's numbers on the
// funnel, with its owner's name (README.md "Decided here"); campaigns.approval_mode changes a
// campaign's approval mode (gamma-p4-070), for campaigns.manage's roles: a Member's own-only change
// is an open question (README.md "Decided here").
import { definePermissions } from "@whytide/platform";
import { APPROVAL_MODE_ROLES } from "./domain/approval-mode/constants.ts";
import { CAMPAIGNS_MANAGE_ROLES } from "./domain/campaigns/constants.ts";

export const permissions = definePermissions(
  [
    { action: "campaigns.approval_mode", roles: [...APPROVAL_MODE_ROLES] },
    { action: "campaigns.manage", roles: [...CAMPAIGNS_MANAGE_ROLES] },
    { action: "campaigns.read", roles: ["Owner", "Admin", "Member"] },
    { action: "campaigns.write", roles: ["Owner", "Admin", "Member"] },
  ],
  import.meta.url,
);

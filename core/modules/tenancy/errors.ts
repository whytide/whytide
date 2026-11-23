// tenancy's codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json.
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({
  /** bootstrapOrganization: an organization has the slug already; nothing was written. 409. */
  organization_exists: {},
  /** createWorkspace: no organization has the id. 404. */
  organization_not_found: {},
  /** createWorkspace: the organization has a workspace with the slug; nothing was written. 409. */
  workspace_exists: {},
  /** addMember, addOwner: no workspace has the id. 404. */
  workspace_not_found: {},
  /** bootstrapOrganization, createWorkspace, addMember, addOwner, GET /v1/me: no such user. 404. */
  user_not_found: {},
  /** A command's input off its rule (domain/rules.ts); `details.fields` names the fields. 400. */
  tenancy_input_invalid: {},
  /** changeRole, removeMember: the workspace holds no membership with the id; changeRole, a removed one. 404. */
  membership_not_found: {},
  /** changeRole, removeMember: the caller's own membership; another Owner changes it. 409. */
  member_is_self: { status: 409 },
  /** changeRole, removeMember: the change would leave the workspace with no active Owner. 409. */
  last_owner: { status: 409 },
});

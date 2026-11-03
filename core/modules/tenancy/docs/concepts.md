# tenancy: concepts

- **User**: a person who signs in, one per email, stored lowercased. `locale` is the language they picked, a BCP 47 tag, empty until they pick one; `disabled_at` set means the account is revoked (alpha-p3-020).
- **Organization**: the customer, with a name and a slug unique across organizations. Core runs one; identity's `pnpm tenant:create` makes more, for testing. Credits belong to it, so all its workspaces spend one balance.
- **Workspace**: where the work happens and the unit of isolation: every tenant row carries its `workspace_id`. It belongs to one organization; its slug, unique in the organization, names it in a URL.
- **Membership**: a user in a workspace with a role, `Owner`, `Admin` or `Member`; one per user and workspace. In alpha every member is an Owner; what each role may do is `permissions.ts` and alpha-p3-030.
- **Slug**: 2 to 40 lowercase letters, digits and single dashes, starting with a letter (`acme`, `sales-emea-2`). An id has an underscore, so a URL's workspace reads as one or the other.
- **Bootstrap**: the first organization, its workspace and its Owner, made together by `bootstrapOrganization` from `ORGANIZATION_NAME` and `WORKSPACE_SLUG` at the first sign-in (alpha-p3-040). A slug taken already is `organization_exists`.

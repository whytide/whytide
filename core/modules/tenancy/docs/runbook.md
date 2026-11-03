# tenancy: runbook

- **Settings**: `ORGANIZATION_NAME`, `WORKSPACE_SLUG`, `FEEDBACK_URL` (README "Settings"); a value off the rules stops the api's start with `config_invalid`, `details.block` `modules/tenancy`, `details.variables` naming the variable. No "Give feedback" link in the header: `FEEDBACK_URL` is unset.
- **Logs**: every read of the global tables logs `tenant: running without a tenant context` with `reason: "tenancy"`.
- **Failure modes**: `organization_exists` (409) when the bootstrap slug is taken: pick another `WORKSPACE_SLUG`; `workspace_exists` (409) from `createWorkspace`: the organization has a workspace with the slug, pick another; `organization_not_found` (404): no organization has the id; `user_not_found` (404) on `GET /v1/me` when the session's user has no row: the authentication adapter and `users` disagree.

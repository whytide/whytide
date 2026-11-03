# privacy: security

Read before changing the module ([security §8](../../../../docs/rules/security.md#8-conduct)); two reviews. This module deletes personal data on request ([security §1](../../../../docs/rules/security.md)): a gap here leaves a person's data behind, and a bug deletes someone else's.

- **Who may run it**: whoever holds the deployment's database settings, from a shell; there is no route, no permission and no screen. `--operator` names them in the log; it is their word, not an identity the command checks.
- **Scope**: one tenant run in the named workspace, through the tenant client: every delete carries the workspace (`tests/tenancy.test.ts` for the platform eraser, the one raw query, which names `workspace_id` itself). The same person in another workspace keeps their rows (`tests/erase.test.ts`).
- **All or nothing**: an error rolls every row back; the dry run rolls back on purpose. So the person is never left half erased, with the hash written and rows kept, or the reverse.
- **What it prints and logs**: counts, codes and the log row's id. Never the person's URL, name or id: a refusal prints its code alone, and a failure its code or class, since a database error's message can quote a query's values. The command writes no log line or span of its own beyond the platform's.
- **The log**: `erasure_log` keeps the URL's erased hash, the counts and the operator: no name, URL, id or text of the person. `app` may not change or remove a row.
- **What it keeps**: `cost_events.subject_ref` and `credit_usage.subject_ref`, with `credit_usage.idempotency_key`, keep the person's opaque id: the cost and the credits of the calls made about them, which billing needs; once the person row is gone the id names nobody. `app` may not delete a `credit_usage` row. The erased hashes stay, so that no source adds the person again.
- **The platform's tables**: privacy erases the outbox events and the idempotency records that name the person, since the platform cannot reach the database; an event that lists other persons keeps them.
- **Coverage**: the pipeline check fails on a tenant table with a `person_id` in a module without an eraser. A person named in another column (`subject_ref`, a JSON payload, `object_ref`) is the module's own eraser's to cover: see runbook.md "What remains".
- **AI**: none; no model sees the person or the request.

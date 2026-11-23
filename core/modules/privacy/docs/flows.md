# privacy: flows

## Erase

`pnpm erase` → `cli/erase.ts` → `domain/erase/erase.ts`, in one process, with no api or worker in between:

1. The command reads its flags and resolves the workspace: an id as given, a slug through tenancy's `findWorkspaceBySlug`.
2. It opens one tenant run in the workspace, as the service principal `privacy`, with 120 seconds to finish.
3. It resolves the person: contacts' `getPerson(id)`, or `findPersonByLinkedinUrl(url)` on the normalized URL; `person_not_found` otherwise.
4. It runs the platform's eraser, then locks the lead (contacts' `lockLeadStatus`), then asks the caller's guard, if any (the 30-day rule's, below), then runs every other registered eraser in dependency order (README.md "Erasers"). Each deletes its rows through `tenantClient` and returns its counts. From the lock on, a reply's hold, an enrollment or a skip of the person waits for the run.
5. It runs contacts' `erasePerson` last: the erased hashes of the URL and of each provider id are written, then the review decisions, the lead and the person are deleted; with the caller's recheck, if any, the person's row is read under its lock right before its delete and handed to it.
6. It writes the `erasure_log` row with the reason `request`, the URL's hash (the first address's for a person without a LinkedIn profile, gamma-rf-050), the counts and the operator.
7. It commits and prints the counts and the log row's id. A dry run throws at this point instead, so the run rolls back, and prints the same counts.

Any error in steps 3 to 6 rolls the run back; so does a refusal of the guard or the recheck, which writes no log row and answers `{ skipped: <code> }`. No event is published: the erasure tells no other module, and no workflow starts.

## The 30-day rule

The schedule `privacy.retention` starts `privacy_retention` daily at 03:15 UTC, on the worker (README.md "The 30-day rule"):

1. The workflow computes the cutoff once, its start less 30 days, and lists the workspaces (`privacy_retention_workspaces`, tenancy's `listWorkspaceIds`).
2. For each workspace in turn, `privacy_retention_run` with `{ workspace, cutoff }`: it reads the workspace's persons through contacts' `listPersons`, 100 a tenant run, keeps the candidates, oldest found first, and runs `erase` for each in a tenant run of its own: steps 2 to 7 above, with the reason `retention_never_contacted`, the operator `retention`, the guard, contacts' `lastTouchAt` still null after the lead's lock, and the recheck, the person's row read again under its own lock right before its delete: still never touched, and still a candidate at the cutoff. The row's lock waits for a touch still being written, which the lead's lock does not: a send's settle before the last step holds only its enrollment. contacts' `erasePerson` runs with `writeErasedHash: false`, so no erased hash is written, and the log row has no hash. It stops at 1,000 deletions, logs the workspace's counts and answers them with the deleted ids. A workspace that fails past its attempts is counted, and the next one runs.
3. If anyone was deleted, a timer of 15 minutes; then `privacy_retention_sweep`: for each deleted id, in a tenant run per person, every registered eraser again, the platform's first. It logs the totals with the rows erased again by table.
4. The workflow answers the totals, or fails with the first workspace's failure, once the sweep has run.

`pnpm retention:check` reads step 2's candidates as of now, per workspace, and deletes nothing.

## Delete a lead

`pnpm lead:delete` → `cli/lead-delete.ts` → `domain/lead-delete/delete.ts`, then `erase`: steps 1 to 7 above, with the reason `lead_deleted`, the guard and the recheck.

1. The guard, after the lead's lock: contacts' `lastTouchAt`, null or `person_contacted`; campaigns' `lockPersonSteps`, which locks the person's enrollments, then their steps, in id order, until the run ends, and counts the steps `executing` or `succeeded`: any is `person_contacted`; contacts' `suppressionOf` with no channel: suppressed is `person_suppressed`.
2. The other erasers, then contacts' `erasePerson` with `writeErasedHash: false`. The recheck, on the person's row under its lock: a touch, or a `sender_outreach` or `threads` row among the counts, is `person_contacted`.
3. The log row with the reason `lead_deleted` and no hash; the commit. A refusal rolls everything back and prints its code.

A sender's claim of one of the person's steps, an update of the step's row on `status = scheduled`, waits for the run from step 1 on, then finds no row and stops; a claim committed before it is counted in step 1.

## Afterwards

A later import (discovery) or signal run (signals) reads the erased hashes before it writes a person: the person is skipped (`skippedErased`, `dropped_hashed`), and contacts' commands answer `person_erased` to any other source. The 30-day rule and `pnpm lead:delete` leave no hash: a new signal, an import or a member may add the person again, as a new person with a new clock, whom a suppression entry they had still suppresses.

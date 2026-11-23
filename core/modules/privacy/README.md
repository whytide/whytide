# privacy

The deletion script: `pnpm erase` erases a person from a workspace on request, every module's rows in one tenant run, and keeps a log of it without the person's data (alpha-p10-030). Each module that keeps a person's rows erases them itself, through a function of its `index.ts`; this module registers those functions in dependency order, runs them, then contacts' `erasePerson`, which deletes the person and leaves the erased hash that stops every source from adding it again. A pipeline check in `test:tenancy` fails when a module adds a table with a `person_id` and no eraser.

- **Owns:** `erasure_log` in `core/packages/db/prisma/schema/privacy.prisma`, migrations `20261027140000_privacy_erasure_log`, `20261101124448_privacy_erasure_reason` and `20261104101759_privacy_lead_deleted` ([docs/data.md](docs/data.md)); the eraser registry in `domain/erase/`; the commands in `cli/erase.ts`, `cli/lead-delete.ts` (both on `cli/command.ts`) and `cli/retention.ts`; the lead deletion in `domain/lead-delete/`; the 30-day rule in `domain/retention/` and its workflow in `workflows/`.
- **Public interface:** `index.ts` exports the registries only, `errors` and `ids` (`era`). No module imports privacy, since privacy imports theirs; no host lists it as a dependency (pnpm refuses the cycle), and the api loads its build as it loads every module's.
- **Depends on:** `contacts` (`getPerson`, `findPersonByLinkedinUrl`, `findPersonByEmail`, `lockLeadStatus`, `erasePerson`, `listPersons`, `lastTouchAt`, `suppressionOf`, `errors`), `campaigns` (`erasePerson`, `lockPersonSteps`), `qualification`, `signals` and `messaging` (`erasePerson`), `ai` (`eraseDecisionRecords`), `tenancy` (`findWorkspace`, `findWorkspaceBySlug`, `listWorkspaceIds`), `db`, `platform`; `@temporalio/workflow` for the workflow.
- **Reviewers:** the owners of this module; two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## The deletion script

```
pnpm erase --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person <id>) --operator <name> [--dry-run]
```

- `--linkedin-url` takes the URL as the request gives it: contacts normalizes it (case, `www.`, query, trailing slash). `--person` takes the person's id. Exactly one of the three.
- `--email` takes an address the person holds, for a person without a LinkedIn profile too (gamma-rf-050): contacts trims it, folds its case and finds the person by its keyed hash (`findPersonByEmail`). The address is never printed, logged or kept; the erased hashes include each address hash the person held, and the log row's is the URL's, else the first address's.
- `--operator` is required: the person who runs the command, written to the log's `performed_by`. The OS user is not used, since in a container it names nobody.
- It prints one line per table, `<module>.<table>: <rows>`, in the order the erasers ran, then `erased: <era_ id>, <n> rows`. It never prints the person's URL, email address, name or id.
- `--dry-run` runs the same erasers and the same log write, prints the same lines and `dry_run: <n> rows counted, all rolled back`, then rolls the run back: nothing changes.
- Exit code 0 when done; 1 for a refusal, printed as its code alone (`person_not_found`, `linkedin_url_invalid`, `contacts_input_invalid` for a text that is no address, `workspace_not_found: …`), or for a failure, printed as `erase_failed: <code or class>, nothing changed`, never the error's message, which can quote a query's values; 2 for a usage error.
- The run has 120 seconds; an error anywhere rolls every row back, and the command can run again.

## Erasers

`defineEraser({ module, dependsOn, erase })` (`domain/erase/registry.ts`) registers a module's function, `erase(personId)`, which deletes the person's rows in the caller's tenant run through `tenantClient` and returns the rows it deleted by table. `dependsOn` names the modules whose rows this module's rows name: those erasers run after this one. `registeredErasers()` gives them in that order, ties by module name; a module twice, a dependency without an eraser or a cycle is `eraser_order_invalid` (500), naming the modules. `domain/erase/erasers.ts` registers:

| Module | Function | Rows |
|---|---|---|
| `approvals` | `erasePerson` | `approval_items` |
| `enrichment` | `erasePerson` | `enrichment_runs` (gamma-en-050); `contact_points`, `enrichment_requests`, `enrichment_cache_entries` (gamma-en-080) |
| `linkedin` | `erasePerson` | `sender_outreach`; `sender_action_log` with the person's id as `object_ref` |
| `messaging` (depends on `ai`) | `erasePerson` | `message_drafts` |
| `platform` (depends on `campaigns`) | `erasePlatformRows` (privacy's own, below) | `outbox`, `idempotency_records` |
| `campaigns` | `erasePerson` | `step_executions`, then `enrollments` |
| `qualification` (depends on `ai`) | `erasePerson` | `score_snapshots`, `criterion_verdicts`, `assessment_attempts`, `intent_scores` |
| `ai` | `eraseDecisionRecords(subjectRef)` | `decision_records` with the person's id as `subject_ref` |
| `signals` (depends on `ai`) | `erasePerson` | `signal_events`, `evidence`, and the `decision_records` their ratings name (a rating batch's, its subject the source) |
| `inbox` (depends on `ai`) | `erasePerson` | `messages`, the person's and every one in their threads, with their `reply_classifications` by the cascade, then `threads` |
| `contacts`, last, outside the registry | `erasePerson` | `review_decisions`, `leads`, `persons`; writes the erased hashes |

The run takes `platform` first, then locks the lead (contacts' `lockLeadStatus`), then runs the others in the registered order (beta-p5-030). An outbox event a delivery has claimed holds the platform's step until that delivery commits, so `campaigns`, after it, also erases the enrollment a `contacts.lead_approved` delivery wrote meanwhile (beta-p2-050); that delivery locks the lead, and a run already holding it would wait with it until the claim times out, a cycle Postgres cannot see. The lead's lock comes before every other eraser: a reply's hold, an enrollment and a skip lock the lead before the steps and items they change, so they wait for the erasure and find the person gone, where they would deadlock with an eraser that deleted those rows. The platform cannot import the database package, so privacy erases the platform's tables itself: the outbox events that name the person in `personId`, or `person_id` in linkedin's snake_case events, are deleted, a `personIds` list loses the person, and an event whose list is left empty is deleted; an idempotency record whose stored answer holds the person's id is deleted. `cost_events` and `credit_usage` keep the id ([docs/security.md](docs/security.md)).

A module that adds a table with a `person_id` exports its eraser from its `index.ts` and registers it in `erasers.ts`; `test:tenancy` fails until it does (`tests/tenancy.test.ts`, the pipeline check, which names the table).

## Testing

`pnpm -F privacy test` runs `tests/erase.test.ts`, the command end to end on the worktree's database (a fixture person in every module, a scan of every table by id, name and URL after it, the dry run, the rollback and the refusals), `tests/order.test.ts`, the order without a database, and `tests/tenancy.test.ts`. `pnpm -F privacy test:tenancy` runs the last: the isolation of `erasure_log`, its grants, the platform eraser's scope, and the pipeline check with its failing fixture, `tests/fixtures/schema/orphan.prisma`. No route, so no `.http` file.

## The 30-day rule

gamma-p7-010 (RB-20.2.3 and RB-20.4.3, reduced). A person of a workspace is a candidate when all three hold (`domain/retention/candidates.ts`):

- no invite, message or email ever went to them: `last_touch_at` is null;
- they were found at or before the cutoff, the run's start less `RETENTION_NEVER_CONTACTED_DAYS` (30): `created_at`, which contacts sets once, so no refresh, re-import or re-enrichment resets the clock;
- they are located in `RETENTION_EU_UK_COUNTRIES` (the 27 EU members; AX, GF, GP, MF, MQ, RE, YT; IS, LI, NO; GB), or nowhere known: `location_country` null or no two-letter code.

The rule is fixed: no setting. The constants are in `domain/retention/constants.ts`.

**The job.** The workflow `privacy_retention` (global), started by the schedule `retention` (`privacy.retention`) daily at 03:15 UTC; Temporal skips a start while a run is under way, and the schedule stays paused while `WORKER_SCHEDULES=off` (core/apps/worker/README.md "Schedules"). The cutoff is computed once, from the workflow's start, and passed on:

1. `privacy_retention_workspaces`: tenancy's `listWorkspaceIds()`.
2. `privacy_retention_run`, one per workspace, `{ workspace, cutoff }` (a global activity's input names no `workspaceId`): the candidates, read through contacts' `listPersons` a page per tenant run, oldest found first, each deleted through `erase` in a tenant run of its own, as the service `privacy`, with the reason `retention_never_contacted`, the operator `retention` (`RETENTION_OPERATOR`), the guard and the recheck; `RETENTION_MAX_PER_RUN` (1,000) at most, the rest the next day. It answers `{ candidates, deleted, skipped, failed }` and the deleted ids.
3. After a run that deleted anyone, a timer of `RETENTION_SWEEP_DELAY_MINUTES` (15); then `privacy_retention_sweep` runs every registered eraser again, the platform's first, for each deleted id, in a tenant run per person, so that a row a batch or a draft in flight wrote for the id after its deletion goes too. contacts' is not among them: the person is gone.

The guard asks contacts' `lastTouchAt` right after the lead's lock, a first look: a touch since the read refuses the deletion (`touched`), and a person gone refuses it (`gone`). A writer of the touch need not hold the lead, though: a send's settle before the last step holds only its enrollment, and inbox's echo locks no lead for a person without one, so a touch not yet committed reads as none. So the recheck reads the person's row again under its lock (`SELECT … FOR UPDATE`, contacts' `erasePerson` with `beforeDelete`), right before contacts deletes it, where the delete takes that lock anyway: it waits for a writer still open, then refuses a touch (`touched`) or a person no longer a candidate at the cutoff, such as one re-imported with a country off the list (`changed`). A refusal rolls the person's run back, with no log row, and counts as `skipped`. A person that fails to delete counts as `failed` and leaves the others; a workspace whose run fails past its 3 attempts leaves the other workspaces, and the workflow fails with its code once the sweep has run. A retry deletes nothing twice: a person deleted is no candidate any more.

**No hash.** With `reason: retention_never_contacted`, `erase` calls contacts' `erasePerson` with `writeErasedHash: false` and writes the log row without a `person_hash`: retention keeps no pseudonymous trace. A person deleted may be found again by a new signal, as a new person with a new `created_at` and a new clock; the engagement that found them first is older than that, past signals' lookbacks (30 days at most) and the source's watermark, so it does not add them again. A suppression entry the person had stays, and still suppresses the person added again. `pnpm erase` keeps the reason `request`, the hash and its output.

**Its lines**, `privacy: retention ran`: one per workspace (`workspace_id`, `candidate_count`, `deleted_count`, `skipped_count`, `failed_count`), then one of the totals (`workspace_count`, the four counts, `workspace_failed_count`, `sweep_failed_count`, `swept_count` and `swept_<module>_<table>_count` per table the sweep erased again); a deletion or a sweep that fails logs a `warn` with the workspace and its code. Never a person's id, URL, name or country; the workflow's inputs and answers hold ids and counts only.

```
pnpm retention:check [--workspace <id or slug>]
```

`cli/retention.ts`, the operator's command on the server: the candidates as of now, read as the job reads them, one line per workspace, `retention_candidates: <workspaceId> <n>`, then `retention_total: <n>`; every workspace without `--workspace` (an id has an underscore, a slug none). It writes nothing and prints no person. Exit 0; 1 for a refusal (`workspace_not_found: …`, or a code) or a failure (`retention_check_failed: <code or class>`); 2 for a usage error. The runbook says when to run it (docs/runbook.md "The 30-day rule").

**Its tests.** `tests/retention.test.ts`, the candidate rule as a table; `tests/retention-check.test.ts`, the command's lines and exit codes; in `tests/erase.test.ts`, the refusals of the guard and the recheck and the rule's path through `erase`; in `tests/tenancy.test.ts`, the CHECK and the job's deletion in one workspace beside the same URL in another. The job end to end, on the slice's Temporal: `core/apps/worker/tests/privacy-retention.test.ts`; its recorded history, `workflows/__histories__/privacy_retention.json`, replays in `pnpm -F worker test:replay`. The worker loads `workflows/index.ts` from privacy's build, and its tests import `testing/` from there: the client of privacy's runs (`usePrivacyClient`) and the cap per run (`useRetentionCap`).

## Deleting a lead

lead-delete-script. A lead that no channel ever reached, such as one added by hand and stopped by the title filter, is deleted with every row of the person's, so that the same person can be added again, by hand, by an import or by a signal:

```
pnpm lead:delete --workspace <id or slug> (--linkedin-url <url> | --email <address> | --person <id>) --operator <name> [--dry-run]
```

- It runs `erase` (`domain/lead-delete/delete.ts`): the same erasers in the same tenant run, with the reason `lead_deleted`, no erased hash (`writeErasedHash: false`) and a log row without one, as the 30-day rule's.
- Its flags, lines, `--dry-run` and exit codes are erase's (`cli/command.ts`). The end line is `deleted: <era_ id>, <n> rows`; a failure prints `lead_delete_failed: <code or class>, nothing changed`.
- The guard, right after the lead's lock: `person_contacted` for a touch (contacts' `lastTouchAt`) or a step `executing` or `succeeded` (campaigns' `lockPersonSteps`); then `person_suppressed` for any entry the never-contact check reads (contacts' `suppressionOf`, every channel): an opt-out or a never-contact entry, on the person or on their company.
- `lockPersonSteps` holds the person's enrollment and steps until the run ends. The sender's claim locks the step's row, not the lead's: a claim that came first is waited for and counted, and a later one waits, then finds its step gone.
- The recheck, on the person's row locked right before its delete: `person_contacted` for a touch written meanwhile, or for a linkedin outreach row or an inbox thread among the rows the erasers deleted.
- A refusal prints its code alone, exits 1 and changes nothing, in a dry run too. `person_not_found`, `linkedin_url_invalid`, `contacts_input_invalid` and `workspace_not_found` are erase's.
- For a contacted or suppressed person the answer is `pnpm erase` (docs/runbook.md "Deleting a lead").

Its tests: `tests/lead-delete.test.ts`, the owner's case end to end (the rows gone, the log row, the same URL added again through contacts' `createLeadByMember`), the dry run, each refusal, the guard's locks, `pnpm erase` still refusing the URL after it, and a lead without a LinkedIn profile deleted by `--email` and added again by the same address; in `tests/tenancy.test.ts`, the CHECK for the reason; campaigns' `tests/tenancy.test.ts` for `lockPersonSteps`.

## Decided here

- The refusals are the guard's and the recheck's codes, as the 30-day rule's are, not entries of `errors.ts`: the error registry is global, and contacts has `person_suppressed` already.
- The outreach row and the thread are read from the erasers' counts at the recheck, so linkedin and inbox need no new query.
- gamma-rf-050: the commands take `--email` as a third key, exactly one of the three, so that a person without a LinkedIn profile can be erased or deleted. The address is passed to contacts and never printed, logged or kept; a text that is no address is refused as `contacts_input_invalid`, contacts' own code, printed alone.
- Any entry the never-contact check reads refuses, a company's too: the strictest answer. An entry keeps its hash after the deletion (contacts' `erasePerson` empties only its URL), so it would still match the person added again.
- A person without a lead is deleted as erase deletes one: no `lead_not_found`.
- `erase` and `lead:delete` share `cli/command.ts`; erase's lines are unchanged (`tests/erase.test.ts`).

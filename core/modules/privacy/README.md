# privacy

The deletion script: `pnpm erase` erases a person from a workspace on request, every module's rows in one tenant run, and keeps a log of it without the person's data (alpha-p10-030). Each module that keeps a person's rows erases them itself, through a function of its `index.ts`; this module registers those functions in dependency order, runs them, then contacts' `erasePerson`, which deletes the person and leaves the erased hash that stops every source from adding it again. A pipeline check in `test:tenancy` fails when a module adds a table with a `person_id` and no eraser.

- **Owns:** `erasure_log` in `core/packages/db/prisma/schema/privacy.prisma`, migration `20261027140000_privacy_erasure_log` ([docs/data.md](docs/data.md)); the eraser registry in `domain/erase/`; the command in `cli/erase.ts`.
- **Public interface:** `index.ts` exports the registries only, `errors` and `ids` (`era`). No module imports privacy, since privacy imports theirs; no host lists it as a dependency (pnpm refuses the cycle), and the api loads its build as it loads every module's.
- **Depends on:** `contacts` (`getPerson`, `findPersonByLinkedinUrl`, `lockLeadStatus`, `erasePerson`, `errors`), `qualification`, `signals` and `messaging` (`erasePerson`), `ai` (`eraseDecisionRecords`), `tenancy` (`findWorkspaceBySlug`), `db`, `platform`.
- **Reviewers:** the owners of this module; two reviews ([security §8](../../../docs/rules/security.md#8-conduct)).

## The deletion script

```
pnpm erase --workspace <id or slug> (--linkedin-url <url> | --person <id>) --operator <name> [--dry-run]
```

- `--linkedin-url` takes the URL as the request gives it: contacts normalizes it (case, `www.`, query, trailing slash). `--person` takes the person's id.
- `--operator` is required: the person who runs the command, written to the log's `performed_by`. The OS user is not used, since in a container it names nobody.
- It prints one line per table, `<module>.<table>: <rows>`, in the order the erasers ran, then `erased: <era_ id>, <n> rows`. It never prints the person's URL, name or id.
- `--dry-run` runs the same erasers and the same log write, prints the same lines and `dry_run: <n> rows counted, all rolled back`, then rolls the run back: nothing changes.
- Exit code 0 when done; 1 for a refusal, printed as its code alone (`person_not_found`, `linkedin_url_invalid`, `workspace_not_found: …`), or for a failure, printed as `erase_failed: <code or class>, nothing changed`, never the error's message, which can quote a query's values; 2 for a usage error.
- The run has 120 seconds; an error anywhere rolls every row back, and the command can run again.

## Erasers

`defineEraser({ module, dependsOn, erase })` (`domain/erase/registry.ts`) registers a module's function, `erase(personId)`, which deletes the person's rows in the caller's tenant run through `tenantClient` and returns the rows it deleted by table. `dependsOn` names the modules whose rows this module's rows name: those erasers run after this one. `registeredErasers()` gives them in that order, ties by module name; a module twice, a dependency without an eraser or a cycle is `eraser_order_invalid` (500), naming the modules. `domain/erase/erasers.ts` registers:

| Module | Function | Rows |
|---|---|---|
| `approvals` | `erasePerson` | `approval_items` |
| `linkedin` | `erasePerson` | `sender_outreach`; `sender_action_log` with the person's id as `object_ref` |
| `messaging` (depends on `ai`) | `erasePerson` | `message_drafts` |
| `platform` (depends on `campaigns`) | `erasePlatformRows` (privacy's own, below) | `outbox`, `idempotency_records` |
| `campaigns` | `erasePerson` | `step_executions`, then `enrollments` |
| `qualification` (depends on `ai`) | `erasePerson` | `score_snapshots`, `criterion_verdicts`, `assessment_attempts` |
| `ai` | `eraseDecisionRecords(subjectRef)` | `decision_records` with the person's id as `subject_ref` |
| `signals` | `erasePerson` | `signal_events`, `evidence` |
| `inbox` | `erasePerson` | `messages`, the person's and every one in their threads, then `threads` |
| `contacts`, last, outside the registry | `erasePerson` | `review_decisions`, `leads`, `persons`; writes the erased hashes |

The run takes `platform` first, then locks the lead (contacts' `lockLeadStatus`), then runs the others in the registered order (beta-p5-030). An outbox event a delivery has claimed holds the platform's step until that delivery commits, so `campaigns`, after it, also erases the enrollment a `contacts.lead_approved` delivery wrote meanwhile (beta-p2-050); that delivery locks the lead, and a run already holding it would wait with it until the claim times out, a cycle Postgres cannot see. The lead's lock comes before every other eraser: a reply's hold, an enrollment and a skip lock the lead before the steps and items they change, so they wait for the erasure and find the person gone, where they would deadlock with an eraser that deleted those rows. The platform cannot import the database package, so privacy erases the platform's tables itself: the outbox events that name the person in `personId`, or `person_id` in linkedin's snake_case events, are deleted, a `personIds` list loses the person, and an event whose list is left empty is deleted; an idempotency record whose stored answer holds the person's id is deleted. `cost_events` and `credit_usage` keep the id ([docs/security.md](docs/security.md)).

A module that adds a table with a `person_id` exports its eraser from its `index.ts` and registers it in `erasers.ts`; `test:tenancy` fails until it does (`tests/tenancy.test.ts`, the pipeline check, which names the table).

## Testing

`pnpm -F privacy test` runs `tests/erase.test.ts`, the command end to end on the worktree's database (a fixture person in every module, a scan of every table by id, name and URL after it, the dry run, the rollback and the refusals), `tests/order.test.ts`, the order without a database, and `tests/tenancy.test.ts`. `pnpm -F privacy test:tenancy` runs the last: the isolation of `erasure_log`, its grants, the platform eraser's scope, and the pipeline check with its failing fixture, `tests/fixtures/schema/orphan.prisma`. No route, so no `.http` file.

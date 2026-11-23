# privacy: runbook

## Receiving a request

1. A person asks to be erased, by email or another channel, and gives their LinkedIn URL, or the email address Whytide may hold for them. Confirm it is their own profile or address, and ask which workspace, or organization, holds them if the request does not say.
2. Record the request where the team keeps them (the ticket names the person; the database will not).
3. Run the command within a day of the request, on a machine with the database settings of the deployment (`.env.local`: `DATABASE_URL`, `HASH_SALT`).

## Running it

1. `pnpm erase --workspace <slug> --linkedin-url <url> --operator <you> --dry-run`: read the counts. `person_not_found` means the workspace has no person with that URL: check the workspace, or the URL, and answer the person that nothing is held.
   - For a person known by an email address, with no LinkedIn profile or with one the request does not give (gamma-rf-050): `--email <address>` in place of `--linkedin-url`. `person_not_found`: no person of the workspace holds that address. `contacts_input_invalid`: the text is no address. The command prints the address nowhere; keep it in the ticket only.
   - A person who holds a profile and an address is found by either. When the request gives both, run it by the URL, then by the address: the second run erases a person known by the address alone, if the workspace has one; `person_not_found` then means no one else held it.
2. The same without `--dry-run`. It prints the same counts and `erased: era_…, <n> rows`. Put the `era_` id in the ticket: it is the proof.
3. Run it once per workspace that holds the person.
4. Prefer a quiet moment: a qualification batch or a draft that started before the command can still write a row for the person after it (below).

`erase_failed: <code or class>, nothing changed` means the run rolled back: run it again; if it fails again, give the code to the module's owners (the command never prints the error's message, which can quote the person's id). `workspace_not_found`: no workspace has the slug, or two organizations share it: pass the workspace's id.

## Deleting a lead

`pnpm lead:delete` deletes a lead that no channel ever reached, with every row of the person's, and keeps no trace, so that the same person can be added again. `pnpm erase` erases a person for good on their request: no source can add them again (`person_erased`). README.md "Deleting a lead" has the rules.

1. Use `lead:delete` for a lead added by mistake, or added by hand and stopped by a filter, whom no invite, message or email reached, in a campaign or not: `pnpm lead:delete --workspace <slug> --linkedin-url <url> --operator <you> --dry-run`, read the counts, then the same without `--dry-run`: `deleted: era_…, <n> rows`. Then add the person again. A lead known by an email address alone takes `--email <address>` in place of `--linkedin-url`.
2. `person_contacted`: a touch, a step sent or being sent, a LinkedIn outreach row or an inbox thread. Deleting a contacted person without a trace would drop the 90-day re-contact guard, and the person added again could be messaged at once: for them the answer is `pnpm erase`, after which they cannot be added again.
3. `person_suppressed`: an opt-out or a never-contact entry names the person or their company, and would still stop the person added again. Leave the lead as it is, or `erase` it on a request.
4. A refusal changes nothing, a dry run included. `lead_delete_failed: <code or class>, nothing changed`: run it again. As for `erase`, prefer a quiet moment: a draft or a qualification batch in flight can still write a row for the old id after the deletion ("What remains").

## The 30-day rule

What the job deletes: every day at 03:15 UTC, in every workspace, each person of the EU, the EEA or the UK, or of no known country, whom no invite, message or email ever reached and who was found 30 days or more before (README.md "The 30-day rule"), through the same erasers as a request, 1,000 a workspace a day at most. It keeps no erased hash: a new signal may find the person again.

1. Before testers start, and before the worker's schedules are turned on (`WORKER_SCHEDULES=on`), run `pnpm retention:check` on the server: it prints `retention_candidates: <workspaceId> <n>` per workspace and `retention_total: <n>`, the people the next run would delete, and writes nothing. `--workspace <id or slug>` counts one workspace. A count that surprises you (a workspace of imported EU leads nobody has contacted yet) is the moment to contact them or export what the team needs: the job will delete them.
2. Read a day's run in the logs: the lines `privacy: retention ran`, one per workspace with its counts, then the totals with the rows the sweep erased again; a `warn`, `privacy: a retention deletion failed` or `privacy: a retention sweep failed`, names the workspace and a code. A person that failed is a candidate again the next day.
3. Read the log rows: `erasure_log` rows with `reason = retention_never_contacted` and `performed_by = retention`, one per person deleted, with no hash: count them by workspace and `completed_at`; they name no one, and answer no question about a given person.

## What remains

In the database, by design:
- the erased hashes in `person_hashes` and the log row: hashes, not reversible without `HASH_SALT`;
- `cost_events.subject_ref` and `credit_usage.subject_ref` (and its `idempotency_key`), the person's id: what a model call or a reservation cost, kept for billing; an id names nobody once the person is gone ([security.md](security.md)).

Outside the database, none of it deleted by the command:
- the import file the person came in, in the files port under `w/<workspace>/imports/`: 30 days at most (discovery);
- a signal run's raw pages and profiles under `w/<workspace>/raw/signals/<run>/`: deleted at the run's end, 72 hours at most (signals);
- a golden set under `w/<workspace>/exports/`: no names, 7 days at most (qualification);
- the reply golden set under `w/<workspace>/exports/`: reply texts with the person's names masked, and the person's and the thread's ids hashed, 7 days at most (inbox, beta-p7-030);
- a grounding sample's sheet under `w/<workspace>/exports/`: why bullets and drafts with their facts, texts about people, 7 days at most (core/packages/ai); `grounding_samples` holds counts and the reader's user id, no person, so it has no eraser;
- Temporal's histories and the logs: ids, codes and counts only; the 30-day rule's histories hold the workspace and person ids it deleted, and the cutoff;
- the Mastra schema holds no input (core/packages/ai's storage test).

Not covered yet:
- a row written after the erasure by a run that started before it: a qualification batch or a draft in flight can write a snapshot or a draft for the person's id. A second run of the command finds no person: such a row needs a follow-up task (Open question of alpha-p10-030). The 30-day rule covers it for its own deletions: its sweep runs the erasers again 15 minutes later;
- linkedin's `sender_action_log.object_ref` admits a person's id, though nothing writes one today; linkedin registers an eraser when a read does.

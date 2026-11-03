# privacy: runbook

## Receiving a request

1. A person asks to be erased, by email or another channel, and gives their LinkedIn URL. Confirm it is their own profile, and ask which workspace, or organization, holds them if the request does not say.
2. Record the request where the team keeps them (the ticket names the person; the database will not).
3. Run the command within a day of the request, on a machine with the database settings of the deployment (`.env.local`: `DATABASE_URL`, `HASH_SALT`).

## Running it

1. `pnpm erase --workspace <slug> --linkedin-url <url> --operator <you> --dry-run`: read the counts. `person_not_found` means the workspace has no person with that URL: check the workspace, or the URL, and answer the person that nothing is held.
2. The same without `--dry-run`. It prints the same counts and `erased: era_…, <n> rows`. Put the `era_` id in the ticket: it is the proof.
3. Run it once per workspace that holds the person.
4. Prefer a quiet moment: a qualification batch or a draft that started before the command can still write a row for the person after it (below).

`erase_failed: <code or class>, nothing changed` means the run rolled back: run it again; if it fails again, give the code to the module's owners (the command never prints the error's message, which can quote the person's id). `workspace_not_found`: no workspace has the slug, or two organizations share it: pass the workspace's id.

## What remains

In the database, by design:
- the erased hashes in `person_hashes` and the log row: hashes, not reversible without `HASH_SALT`;
- `cost_events.subject_ref` and `credit_usage.subject_ref` (and its `idempotency_key`), the person's id: what a model call or a reservation cost, kept for billing; an id names nobody once the person is gone ([security.md](security.md)).

Outside the database, none of it deleted by the command:
- the import file the person came in, in the files port under `w/<workspace>/imports/`: 30 days at most (discovery);
- a signal run's raw pages and profiles under `w/<workspace>/raw/signals/<run>/`: deleted at the run's end, 72 hours at most (signals);
- a golden set under `w/<workspace>/exports/`: no names, 7 days at most (qualification);
- a grounding sample's sheet under `w/<workspace>/exports/`: why bullets and drafts with their facts, texts about people, 7 days at most (core/packages/ai); `grounding_samples` holds counts and the reader's user id, no person, so it has no eraser;
- Temporal's histories and the logs: ids, codes and counts only;
- the Mastra schema holds no input (core/packages/ai's storage test).

Not covered yet:
- a row written after the erasure by a run that started before it: a qualification batch or a draft in flight can write a snapshot or a draft for the person's id. A second run of the command finds no person: such a row needs a follow-up task (Open question of alpha-p10-030);
- linkedin's `sender_action_log.object_ref` admits a person's id, though nothing writes one today; linkedin registers an eraser when a read does.

# privacy: flows

## Erase

`pnpm erase` → `cli/erase.ts` → `domain/erase/erase.ts`, in one process, with no api or worker in between:

1. The command reads its flags and resolves the workspace: an id as given, a slug through tenancy's `findWorkspaceBySlug`.
2. It opens one tenant run in the workspace, as the service principal `privacy`, with 120 seconds to finish.
3. It resolves the person: contacts' `getPerson(id)`, or `findPersonByLinkedinUrl(url)` on the normalized URL; `person_not_found` otherwise.
4. It runs the platform's eraser, then locks the lead (contacts' `lockLeadStatus`), then every other registered eraser in dependency order (README.md "Erasers"). Each deletes its rows through `tenantClient` and returns its counts. From the lock on, a reply's hold, an enrollment or a skip of the person waits for the run.
5. It runs contacts' `erasePerson` last: the erased hashes of the URL and of each provider id are written, then the review decisions, the lead and the person are deleted.
6. It writes the `erasure_log` row with the URL's hash, the counts and the operator.
7. It commits and prints the counts and the log row's id. A dry run throws at this point instead, so the run rolls back, and prints the same counts.

Any error in steps 3 to 6 rolls the run back. No event is published: the erasure tells no other module, and no workflow starts.

## Afterwards

A later import (discovery) or signal run (signals) reads the erased hashes before it writes a person: the person is skipped (`skippedErased`, `dropped_hashed`), and contacts' commands answer `person_erased` to any other source.

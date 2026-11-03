# icp: security

Read before changing the module ([security §8](../../../../docs/rules/security.md#8-conduct)).

- **Tenancy**: every query goes through the caller's tenant run (`tenantClient`), scoped to its workspace, which comes from the URL, never from a body; `readIcpForScoring` refuses another workspace than its run's (`tenant_mismatch`). `tests/tenancy.test.ts` registers `icps` and `criteria` in the two-workspace harness and checks the query with `assertScoped`.
- **Who may do what**: `icp.read` (Owner, Admin, Member) and `icp.write` (Owner, Admin) on every route; the roles are kept, not evaluated, in alpha.
- **What the AI sees**: titles, industries, must-haves and disqualifiers reach the assessment prompt (alpha-p6-020) as data in delimited blocks, never instructions ([security §6](../../../../docs/rules/security.md#6-ai)). Their limits keep the prompt bounded: 50 and 30 items of 100 characters, 1,000 characters per text.
- **The drafter** (`icp.draft-profile`) sees Company Knowledge's content fields and the admin's brief in the `<company>` and `<brief>` blocks, data, never instructions; no person's data. Its answer is checked by the schema and the gate, then shown to an engineer, and only the script's save writes a field. The event and the workflow carry ids; the brief, the sources and the draft stay out of every log line and of the script's output, but for the proposal it prints.
- **The screen** calls the api from the browser, through the web's `/api` rewrite, with the session cookie and the api's origin check; it holds no secret and keeps nothing in the browser.
- **Personal data**: none stored. The events carry ids and a version; an error's details carry paths and a sum, never a value.

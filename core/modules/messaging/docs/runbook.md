# messaging: runbook

Settings: `LINKEDIN_NOTE_LIMIT`, `AI_MODEL_MESSAGING_PLAN_MESSAGE`, `AI_MODEL_MESSAGING_WRITE_MESSAGE` (README.md "Settings"); a model must be priced in `COST_PRICES_JSON`, or the worker refuses to start (`cost_price_missing`). The route logs the api's request line only; a failure is a code:
- `dossier_lead_not_found` (404): the workspace has no lead for the person; check contacts' lead.
- `writer_agent_not_loaded` (500): the process started without `loadAgentTasks()`, which the worker runs at its start.
- `draft_not_found` (404), `draft_not_editable` (409: the draft is being written; ask again once it is not `drafting`), `messaging_input_invalid` (400: an edit above the channel's limit).
- `internal_error` (500) with a `ZodError` in the log: the assembly built a dossier its schema refuses, a bug in `domain/dossier/assemble.ts`; never loosen the schema to pass it.

A draft's `flag_reasons` says why it is not `ready`: a gate's issues (`flagged`: edit or regenerate it), or `{ code }` (`failed`): `ai_failed` (the model's answer failed its schema twice; its decision record, `decision_record_id`, holds why), `draft_requester_not_member` (the member left the workspace), `dossier_lead_not_found` (the lead was deleted), `write_failed` (the writer failed past its three attempts: the workflow `messaging.draft:<workspace>:<draft>` in Temporal shows the activity's error code). A draft `drafting` for long has no run: check that the worker runs and that its outbox delivered `messaging.draft_requested`; the draft panel shows it as being written, asks for it less often as it ages and, past twenty minutes, stops with a note and Check again, which reads it once. The panel's error state names the code of a read the api refused; its retry reads the page again.

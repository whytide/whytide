# icp: runbook

- **Settings**: `AI_MODEL_ICP_DRAFT_PROFILE`, the drafter's model; empty, the LLM port's first model.
- **Failure modes**: 400 `icp_unknown_seniority`, `icp_unknown_size_range` or `icp_unknown_country`: `details.fields` names the values off the list by their path. 400 `icp_weights_must_sum_100`: `details.sum` is what the six added up to. 500 `tenant_mismatch` from `readIcpForScoring`: the caller passed another workspace than its run's.
- **The draft** (`pnpm icp:draft`): `icp_draft_timed_out`: the worker is not running, or not on the stack's Temporal; start it and run the script again. `icp_draft_failed: ai_failed`: the model's answer failed its schema or gate twice, see the decision record; `draft_failed`: the drafter failed three times (the model's port, the database), see the worker's log; `icp_draft_no_source`: the workspace has no Company Knowledge, pass `--brief`. `icp_not_empty`: the ICP has targeting, pass `--replace`. 500 `icp_draft_agent_not_loaded`: the worker started without the drafter's task.
- **Events**: `icp.updated` and `icp.draft_requested` rows in `outbox`, delivered by the worker; a dead one is replayed with the platform's `replayDeadLetter`.

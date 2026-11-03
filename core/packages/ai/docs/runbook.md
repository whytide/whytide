# @whytide/ai: runbook

## The raw purge

A decision record keeps its raw prompt and output `AI_RAW_RETENTION_DAYS` days, 30 ([security §6](../../../../docs/rules/security.md#6-ai)); then `purgeRawRecords` nulls them ([README](../README.md#the-raw-purge)).

- **Run** `pnpm -F ai purge-raw` from the repository root, with the `app` role's `DATABASE_URL` and `APP_ENV` from the environment or `.env.local`. It prints the count: `purge-raw: the raw prompt and output of 12 decision records nulled`.
- **When:** once a day, until a later task's schedule does it. A missed day is caught up by the next run, which takes every record past its date.
- **Again** at any time: a purged record is not touched twice, and nothing else of a record changes (output, gates, tokens, cost).
- **On failure** the error names the variable (`DATABASE_URL is not set: run pnpm env:create …`) or the database's code; the update is one statement, so nothing changed. Fix it and run again.

## The weekly grounding sample

Each week, for each customer workspace, an engineer draws and a person who knows the leads reads ([README](../README.md#the-grounding-sample)):

1. **Draw** last week's sample: `pnpm grounding-sample --workspace <id or slug> --week 2026-W43` (the ISO week; `date -u +%G-W%V` gives this one). Draw it within 30 days: past its raw prompt's `raw_purge_after`, a why bullet's facts are the person and the company as they are now, without the evidence (sources `persons/…`, `workspace_companies/…`).
2. **Read** the sheet, `w/<workspaceId>/exports/grounding-sample-<week>.csv` in the files store, kept 7 days: for each text, count in `invented_facts` every fact it states that its facts do not hold. A draft's sender's name is not among its facts.
3. **Record** the total: `pnpm grounding-sample --workspace <id or slug> --week <week> --record <invented facts> --reviewer <email>`, the reader's account; recording again replaces the week's row.
4. **Above zero**, alpha's measure is missed: open a task that changes the prompt (a new version) or the gate that let the fact through, with an eval case made from the text, its data synthetic, and run its evals (`pnpm -F ai eval <task>`) before the merge.

# qualification: data

## Hard-filter reasons

The hard filters store nothing. The reasons, a closed list (`HARD_FILTER_REASONS`), which the batch writes to the lead's `hard_filter_reason` (alpha-p6-040):

| Reason | The person failed on | `detail.value` |
|---|---|---|
| `title_mismatch` | the title: no ICP title has all its tokens in it | the person's title, trimmed |
| `country_mismatch` | the country: none of the ICP's | the person's country code, upper case |
| `size_mismatch` | the company size: none of its ranges in the ICP's | the company's size as stored, trimmed |

`detail.icp` is the ICP's list the value was compared with: its titles, countries or size ranges. The result is plain JSON.

Personal data: `detail.value` is a business profile field (a title, a country, a company size). A caller keeps it with the lead only, never with a rejected candidate, whose salted hash keeps the reason alone ([security §2](../../../../docs/rules/security.md#2-personal-data)).

## The assessment's tables

`core/packages/db/prisma/schema/qualification.prisma`, migration `20261022191000_qualification_snapshots`. Both are tenant tables; `assessPerson` writes them, `erasePerson` deletes them, with the person's `assessment_attempts`.

`score_snapshots` (`ssn_`): one assessment of a person against the ICP at one version.

| Column | |
|---|---|
| `person_id` | contacts' person; no foreign key across modules |
| `icp_version` | the ICP's version the assessment read |
| `model_id`, `prompt_version` | the model and the prompt the call used |
| `decision_record_id` | the call's decision record in core/packages/ai; unique with `workspace_id`, `icp_version` and `criteria_hash` |
| `criteria_hash` | empty for the assessment's own snapshot; a re-score's copy holds the sha256 of the criteria it is scored with (each one's key, weight, must and enabled, by key), migration `20261022195000_qualification_criteria_hash` |
| `scored_criteria_hash` | the same hash of the criteria that scored the snapshot, the assessment's own included, outside the unique key; empty until scored, and for an assessment's snapshot scored before migration `20261022211000_qualification_batch_robustness`, which copied `criteria_hash` into it |
| `summary` | the model's one sentence; `pii: business_contact` |
| `disqualifiers` | the codes the model found, each once (`qualification_disqualifier`) |
| `status` | `assessed` when written; alpha-p6-030 sets `qualified`, `not_qualified` or `needs_review` |
| `fit_score`, `confidence`, `tier`, `scorer_version` | null until alpha-p6-030 scores |
| `created_at` | indexed with `workspace_id` and `person_id` |

`criterion_verdicts` (`cvd_`): the six verdicts of a snapshot, one per criterion (unique), linked by `(workspace_id, snapshot_id)` and deleted with it (`ON DELETE CASCADE`).

| Column | |
|---|---|
| `criterion` | `title_function`, `seniority`, `company_size`, `industry`, `location`, `must_haves` |
| `verdict` | `met`, `partially_met`, `not_met`, `unknown` |
| `evidence` | the model's quote of the person's data; empty when `unknown`; `pii: business_contact` |
| `weight`, `points` | null until alpha-p6-030 scores |

`assessment_attempts` (alpha-p10-100, migration `20261022211000_qualification_batch_robustness`): a lead's attempt at one ICP version, primary key `(workspace_id, person_id, icp_version)`; no row is the first. `attempt` is the next attempt, moved by each release of the lead's reservation. Ids and a count only, a tenant table.

## The batch's codes

The batch (alpha-p6-040) writes the lead's `status_reason`: `insufficient_credits` or `provider_failed` on a lead it leaves `pending` (alpha-p10-100); on an `ai_failed` lead, the assessment's reason (`invalid`, `gates`, `empty`, `length`, `content_filter`, any other finish reason) or `provider_failed`, at the third attempt. Its reservation's key is `qual:{personId}:{icpVersion}:{model}:{promptVersion}`, then `:{attempt}` from the second. `qualification.lead_qualified` carries ids, the status and the tier only.

## The score and the why

`scoreSnapshot` (alpha-p6-030) fills a snapshot once: `scorer_version` `fit-v1`, `fit_score` (0 to 100), `confidence`, `tier`, and `status`, from `assessed` to `qualified`, `not_qualified` or `needs_review`; each verdict gets its `weight` (its criterion's in this fit, 0 when the ICP disabled it) and its `points` (1, 0.5, 0.4 or 0). A scored snapshot is never written again.

The lead's columns are contacts' (`leads`), written in the same run through `applyQualification`: `qualification_status`, `fit_score`, `fit_confidence`, `tier`, `why`, `current_score_snapshot_id`, `icp_version_scored`, and `status_reason`, a disqualifier's code or null.

`why` holds up to three bullets `{ key, params }`, in this order: what stops the lead, the fit, the gap. Each key's message is in `messages/en.json`. A param is a number, a code that the message words through an ICU `select`, or a quote, 300 code points at most:

| Key | When | Params |
|---|---|---|
| `qualification.why.hard_filtered` | the hard filters stopped the lead; the batch stores it with `hard_filtered` | `reason`, a hard-filter reason; `value`, the person's or the company's; `icp`, the ICP's list joined by `, ` |
| `qualification.why.disqualified` | a disqualifier | `disqualifier`, the first in the closed list's order |
| `qualification.why.must_missed` | a must at `not_met`, no disqualifier | `criterion`, the heaviest such; `quote`, its evidence |
| `qualification.why.fit` | a criterion that counts is `met` | `criterion`, the heaviest met; `quote`, its evidence; `met`, how many are met; `total`, how many count |
| `qualification.why.gap` | a criterion that counts is `unknown` | `criterion`, the heaviest unknown; `more`, how many other unknowns |

Personal data: a `quote` or a `value` repeats the profile's words, so `why` is `business_contact`, as contacts classes it. The model's summary never enters it.

## The golden set's line

`exports/golden-set-<date>.jsonl` (alpha-p9-050; [README](../README.md#the-golden-set)): one JSON object a line, per reviewed lead, its snapshot the one the lead had at its latest decision.

| Key | |
|---|---|
| `person_sha256` | the sha256, in hex, of the person's id; no id of the person, the snapshot or the record |
| `input_from` | `decision_record`, read back from the record's `raw_prompt`, before its `raw_purge_after`; `rebuilt`, by the anonymizer from the person, the company and the ICP as they are now, without evidence |
| `input` | the assessment's input, `{ profile, company, evidence, icp, must_haves, disqualifiers }`, as an eval case's `input` |
| `model_id`, `prompt_version` | the snapshot's; null without one |
| `verdicts` | `{ criterion, verdict, evidence }`, in the criteria's order; empty without a snapshot |
| `disqualifiers`, `status`, `fit`, `tier` | the snapshot's; empty or null without one |
| `decision`, `reason_code`, `reason_text`, `good_reason_text` | the latest decision (contacts' `review_decisions`) |

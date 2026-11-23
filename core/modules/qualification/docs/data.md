# qualification: data

## Hard-filter reasons

The hard filters store nothing. The reasons, a closed list (`HARD_FILTER_REASONS`), which the batch writes to the lead's `hard_filter_reason` (alpha-p6-040):

| Reason | The person failed on | `detail.value` |
|---|---|---|
| `title_mismatch` | the title: no ICP title has all its tokens in it; no longer written since title-check-ai, older leads keep it until the batch assesses them | the person's title, trimmed |
| `country_mismatch` | the country: none of the ICP's | the person's country code, upper case |
| `size_mismatch` | the company size: none of its ranges in the ICP's | the company's size as stored, trimmed |

`detail.icp` is the ICP's list the value was compared with: its titles, countries or size ranges. The result is plain JSON.

Personal data: `detail.value` is a business profile field (a title, a country, a company size). A caller keeps it with the lead only, never with a rejected candidate, whose salted hash keeps the reason alone ([security §2](../../../../docs/rules/security.md#2-personal-data)).

## The assessment's tables

`core/packages/db/prisma/schema/qualification.prisma`, migration `20261022191000_qualification_snapshots`. Both are tenant tables; `assessPerson` writes them, `erasePerson` deletes them, with the person's `assessment_attempts`.

`score_snapshots` (`ssn_`): one assessment of a person against an audience (an ICP) at one version.

| Column | |
|---|---|
| `person_id` | contacts' person; no foreign key across modules |
| `icp_id` | the audience the assessment read, icp's id; no foreign key across modules (gamma-p5-050, migration `20261113034207_qualification_audiences`). The rows before it were filled with the workspace's default audience; a row the release before inserts without it takes the default from the trigger `score_snapshots_default_icp_id`. Null only for an old row of a workspace that had no default |
| `icp_version` | the audience's version the assessment read |
| `model_id`, `prompt_version` | the model and the prompt the call used |
| `decision_record_id` | the call's decision record in core/packages/ai; unique with `workspace_id`, `icp_id`, `icp_version` and `criteria_hash` |
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
| `verdict` | the model's: `met`, `partially_met`, `not_met`, `unknown`; null on a row that holds a member's verdict alone |
| `evidence` | the model's quote of the person's data; empty when `unknown`; `pii: business_contact` |
| `weight`, `points` | null until alpha-p6-030 scores; `points` are the effective verdict's |
| `member_verdict`, `member_note`, `member_set_by`, `member_set_at` | a member's verdict, which counts instead of the model's, its note (500 characters at most; `pii: business_contact`), the user who set it and when; all null without one (lead-verdict-edit, migration `20261102205025_qualification_member_verdicts`, whose CHECKs keep them together and a row with a verdict) |

`assessment_attempts` (alpha-p10-100, migration `20261022211000_qualification_batch_robustness`): a lead's attempt against one audience at one version, primary key `(workspace_id, person_id, icp_id, icp_version)` since gamma-p5-050 (migration `20261113034207_qualification_audiences`, which filled the old rows with the default audience and gave a row the release before inserts the default by the trigger `assessment_attempts_default_icp_id`); no row is the first. `attempt` is the next attempt, moved by each release of the lead's reservation, and by a member's press to the first of the next round of three (lead-rescore-ai). Ids and a count only, a tenant table.

## The batch's codes

The batch (alpha-p6-040) writes the lead's `status_reason`: `insufficient_credits` or `provider_failed` on a lead it leaves `pending` (alpha-p10-100); on an `ai_failed` lead, the assessment's reason (`invalid`, `gates`, `empty`, `length`, `content_filter`, any other finish reason) or `provider_failed`, at the third attempt of a round. A member's press writes `member_requested` on the lead it puts back to `pending`, which keeps its `current_score_snapshot_id` until the new decision (lead-rescore-ai); the batch's codes replace it while the lead waits. Its reservation's key is `qual:{personId}:{icpId}:{icpVersion}:{model}:{promptVersion}`, then `:{attempt}` from the second; a batch started before gamma-p5-050 keeps `qual:{personId}:{icpVersion}:{model}:{promptVersion}`. `qualification.lead_qualified` carries ids, the status and the tier only.

## The score and the why

`scoreSnapshot` (alpha-p6-030) fills a snapshot once: `scorer_version` `fit-v1`, `fit_score` (0 to 100), `confidence`, `tier`, and `status`, from `assessed` to `qualified`, `not_qualified` or `needs_review`; each verdict gets its `weight` (its criterion's in this fit, 0 when the ICP disabled it) and its `points` (1, 0.5, 0.4 or 0). A scored snapshot's scores are written again only when a member's verdict changes (README "A member's verdict"): from the effective verdicts, the member's when set.

The lead's columns are contacts' (`leads`), written in the same run through `applyQualification`: `qualification_status`, `fit_score`, `fit_confidence`, `tier`, `why`, `current_score_snapshot_id`, `icp_id_scored` (the audience it was judged against, gamma-p5-050; the intent write sends it again), `icp_version_scored`, and `status_reason`, a disqualifier's code or null.

`why` holds up to three bullets `{ key, params }`, in this order: what stops the lead, the fit, the why now (with a signal reader, gamma-p5-060), the gap; the gap's goes when there are four. Each key's message is in `messages/en.json`. A param is a number, a code that the message words through an ICU `select`, or a quote, 300 code points at most:

| Key | When | Params |
|---|---|---|
| `qualification.why.hard_filtered` | the hard filters stopped the lead; the batch stores it with `hard_filtered` | `reason`, a hard-filter reason; `value`, the person's or the company's; `icp`, the ICP's list joined by `, ` |
| `qualification.why.disqualified` | a disqualifier | `disqualifier`, the first in the closed list's order |
| `qualification.why.must_missed` | a must at `not_met`, no disqualifier | `criterion`, the heaviest such; `quote`, its evidence |
| `qualification.why.fit` | a criterion that counts is `met` | `criterion`, the heaviest met; `quote`, its evidence; `met`, how many are met; `total`, how many count |
| `qualification.why.fit_member` | the same when the heaviest met is a member's verdict | `criterion`, `met`, `total`; no quote |
| `qualification.why.must_missed_member` | the same as `must_missed` when the must is a member's `not_met` | `criterion`; no quote |
| `qualification.why.gap` | a criterion that counts is `unknown` | `criterion`, the heaviest unknown; `more`, how many other unknowns |
| `qualification.why.why_now` | the lead's strongest signal, with a signal reader ([README](../README.md#intent-and-priority)) | `kind`, its event kind; `role`, `author`, `comment` or `reaction` (a repost counts as one); `days`, the whole days since it |

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

## The intent's table

`intent_scores` (gamma-p5-060, migration `20261030170000_qualification_intent_scores`; [README](../README.md#intent-and-priority)): the current intent of a lead with a decision, one row per person, primary key `(workspace_id, person_id)`, a tenant table. A decision, the re-score and the nightly decay write it; the batch deletes it as it writes a lead `hard_filtered` or `ai_failed`, an update deletes the row of a person without a decision, and `erasePerson` deletes it. Ids, codes, numbers and times only: no words of the person's.

| Column | |
|---|---|
| `intent_score` | 0 to 100 under the scorer version (a CHECK) |
| `priority` | 0 to 100 (a CHECK), from the lead's fit and the intent, the boost included |
| `tier` | the lead's tier from the priority; null for a `not_qualified` lead |
| `intent_breakdown` | each item that counts, strongest first: `{ eventId, kind, role, contribution, at, ownerUserId }`, the contribution its term of S before the stacking bonus, in hundredths; `at` the signal's date, ISO, never after `computed_at`, and `ownerUserId` the member who created its source, null when none is known (both since gamma-p5-065; a row written before has neither until its next write) |
| `why_now_event_id` | the event the why-now bullet names; null without one |
| `boost_until` | when the boost ends; null when no item boosts |
| `scorer_version` | `intent-v1` |
| `computed_at` | the time the intent is computed as of: the decision's, the re-score's or the night's |
| `hot_alerted_at` | the Hot alert's claim (gamma-p5-065, migration `20261102125754_qualification_hot_alert`; [README](../README.md#the-hot-alert)): set by `qualification.lead_hot`'s subscriber while null and the row Hot, before the mail; a write of another tier clears it; null otherwise |

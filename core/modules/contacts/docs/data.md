# contacts: data

Five tenant tables in `core/packages/db/prisma/schema/contacts.prisma`, created by the migrations `20261022150500_contacts_initial`, `20261022180000_contacts_leads` and `20261022210000_contacts_review_decisions`. Every id is `<prefix>_<ULID>` (`ids.ts`), every row has its `workspace_id`, every time is a `timestamptz`.

| Table | Id | Columns | Keys |
|---|---|---|---|
| `persons` | `per_` | `linkedin_url`, `provider_refs`, `first_name`, `last_name`, `headline`, `title`, `company_name`, `company_id`, `location_text`, `location_country`, `field_provenance`, `created_at`, `updated_at` | `(workspace_id, linkedin_url)` and `(workspace_id, id)` unique; CHECK `persons_linkedin_url_lowercase`; `(workspace_id, company_id)` references `workspace_companies (workspace_id, id)`, a delete restricted |
| `workspace_companies` | `wco_` | `name`, `domain`, `linkedin_url`, `industry`, `size_range`, `country`, `provider_refs`, `field_provenance`, `created_at`, `updated_at` | `(workspace_id, linkedin_url)`, `(workspace_id, domain)` and `(workspace_id, id)` unique |
| `leads` | the person's: `person_id` | `qualification_status` (`pending`, `hard_filtered`, `qualified`, `not_qualified`, `needs_review`, `ai_failed`), `source_label` (`signal`, `imported`), `sources` (`[{ kind, ref, at, label?, url? }]`), `first_source_at`, `fit_score` (0 to 100), `fit_confidence` (`high`, `medium`, `low`), `tier` (`hot`, `warm`, `cool`), `current_score_snapshot_id`, `why` (`[{ key, params }]`, three at most), `hard_filter_reason`, `status_reason`, `icp_version_scored`, `review_status` (`good_lead`, `not_a_fit`) and `reviewed_at`, the latest decision's, `created_at` (milliseconds), `updated_at` | `(workspace_id, person_id)` unique and references `persons (workspace_id, id)`, deleted with the person |
| `review_decisions` | `rvd_` | `person_id`, `decision` (`good_lead`, `not_a_fit`), `reason_code` (the fifteen codes, docs/concepts.md), `reason_text`, `good_reason_text`, `snapshot_id`, `fit_at_decision`, `tier_at_decision`, `decided_by`, `decided_at` | `(workspace_id, person_id)` references `leads`, a delete restricted; append-only: `app` has no UPDATE on it |
| `person_hashes` | `phash_` | `hash`, `kind` (`rejected_candidate`, `erased`), `drop_reasons` (`{ code: count }`), `created_at`, `expires_at` | `(workspace_id, hash)` unique; CHECK `person_hashes_expiry`: `expires_at` is null for `erased` and only then |

**PII classes** (`domain/fields.ts`; a `/// pii: <class>` line above each such column; data model §2.6): `business_contact` for the `persons` columns about the person (`linkedin_url`, `provider_refs`, `first_name`, `last_name`, `headline`, `title`, `company_name`, `location_text`, `location_country`); `personal` for `person_hashes.hash`, pseudonymous; `business_contact` for `leads.why`, whose bullets may quote the profile, and for `review_decisions.reason_text` and `good_reason_text`, the tester's words; `none` for the rest, every `workspace_companies` column and every other `leads` column included: a lead copies no field of its person. `tests/schema.test.ts` holds the tables to this list.

**Provenance**: `field_provenance` is `{ <field>: { source, provider, at } }`, one entry per field with a value, keyed by the camelCase name; `provider_refs` is `{ <provider>: <member id> }`.

**Retention**: a person, its lead and its review decisions until `erasePerson` (or, later, the workspace's deletion); a `rejected_candidate` hash 90 days, then `purgeExpiredHashes`; an `erased` hash for good.

**Sorts** (`domain/leads.ts`): `fit` by `fit_score`, none last; `newest` by `created_at`; `unreviewed_first` by `review_status`, none first, then the enum's order (`good_lead`, `not_a_fit`), then as `fit`; each ties by the person id.

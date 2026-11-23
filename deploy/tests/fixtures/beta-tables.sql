-- Beta's tables, a row in each, for the backup drill of production.test.ts, run by psql as Postgres's
-- superuser with the fixture's workspace and owner in :'workspace' and :'owner'. Each row is in an end
-- state that no schedule of the worker acts on, so that nothing writes them after the snapshot, before
-- the backup or once the restored worker starts: a person invited, accepted and replied to, whose
-- enrollment ended with the reply. The platform's switches and their event come from the drill's
-- `sending open`, through linkedin's command. No sender account row: beta's tables name an account
-- by its id alone, and an account's row is the hourly refresh's and the daily ramp's to change. The
-- ids are made up, each in its table's prefix; the data is synthetic.
BEGIN;

-- contacts: the person, the lead the status change needs (decided at the workspace's ICP version,
-- so qualification's tick passes it over), the change to replied, a company's block, and an
-- exclusion list, removed (gamma-p2-045), with the domain it named (review-gaps).
INSERT INTO persons (id, workspace_id, linkedin_url, field_provenance, updated_at)
VALUES ('per_drill', :'workspace', 'https://www.linkedin.com/in/drill-person', '{}', now());

INSERT INTO leads (person_id, workspace_id, qualification_status, source_label, sources,
  first_source_at, icp_version_scored, outreach_status, updated_at)
VALUES ('per_drill', :'workspace', 'qualified', 'imported', '[]', now() - interval '21 days',
  (SELECT max(version) FROM icps WHERE workspace_id = :'workspace'), 'replied', now());

INSERT INTO lead_status_changes (id, workspace_id, person_id, from_status, to_status, actor_type,
  created_at)
VALUES ('lsc_drill', :'workspace', 'per_drill', 'in_campaign', 'replied', 'system',
  now() - interval '2 days');

INSERT INTO suppression_entries (id, workspace_id, layer, match_type, hash, domain, source,
  created_by)
VALUES ('sup_drill', :'workspace', 'blocklist', 'domain', 'drill-domain-hash', 'drill.example',
  'manual', :'owner');

INSERT INTO exclusion_lists (id, workspace_id, name, relationship, entry_count, duplicate_count,
  invalid_count, created_by, removed_at, removed_by)
VALUES ('exl_drill', :'workspace', 'drill-customers.csv', 'customer', 0, 0, 0, :'owner', now(),
  :'owner');

INSERT INTO exclusion_list_domains (workspace_id, exclusion_list_id, hash)
VALUES (:'workspace', 'exl_drill', 'drill-list-domain-hash');

-- campaigns and approvals: the enrollment, ended by the reply, its connection request sent, and
-- the request's approved item. The reply actions' columns (gamma-p4-050), each in an end state: an
-- earlier out-of-office hold's release, the reply's not_interested label and its cool-down, and a
-- reminder already mailed, which the queue run passes over (synthetic times).
INSERT INTO enrollments (id, workspace_id, person_id, sender_account_id, template_id,
  template_version, status, source_event_id, started_at, ended_at, resumed_at, reply_label,
  reply_label_at, cool_down_until, remind_at, remind_user_id, reminded_at, updated_at)
VALUES ('enl_drill', :'workspace', 'per_drill', 'sac_drill', 'linkedin_default', 1, 'replied',
  'evt_drill', now() - interval '21 days', now() - interval '2 days', now() - interval '12 days',
  'not_interested', now() - interval '2 days', now() + interval '178 days',
  now() - interval '1 day', :'owner', now() - interval '1 day', now());

INSERT INTO step_executions (id, workspace_id, enrollment_id, person_id, sender_account_id,
  template_id, template_version, step_key, position, action_type, step_template_hash,
  idempotency_key, status, due_at, scheduled_for, quota_day, executed_at, attempt,
  approval_item_id, accepted_at, updated_at)
VALUES ('sx_drill', :'workspace', 'enl_drill', 'per_drill', 'sac_drill', 'linkedin_default', 1,
  'connect', 1, 'invite', 'drill-step-hash', 'drill-idempotency-key', 'succeeded',
  now() - interval '21 days', now() - interval '20 days', to_char(now() - interval '20 days',
  'YYYY-MM-DD'), now() - interval '20 days', 1, 'apv_drill', now() - interval '19 days', now());

-- campaigns (gamma-p3-030): the seeded campaign the enrollment joined, linkedin_default, active and
-- owned by the owner, its version 1 and the version's connection request, the step the enrollment's
-- sx_drill was made from; the current version is set once the version is there. Its approval mode
-- (gamma-p4-070): review_first_touches, set by the owner once its 7 days of review_everything ended.
INSERT INTO campaigns (id, workspace_id, key_ref, name, status, owner_user_id, launched_at,
  created_by, approval_mode, review_locked_until, approval_mode_set_by, approval_mode_set_at,
  updated_at)
VALUES ('cmp_drill', :'workspace', 'linkedin_default', '', 'active', :'owner',
  now() - interval '21 days', 'system', 'review_first_touches', now() - interval '14 days',
  :'owner', now() - interval '13 days', now());

INSERT INTO campaign_versions (id, workspace_id, campaign_id, version_no, change_kind, created_by,
  created_at)
VALUES ('cmv_drill', :'workspace', 'cmp_drill', 1, 'initial', 'system', now() - interval '21 days');

UPDATE campaigns SET current_version_id = 'cmv_drill' WHERE id = 'cmp_drill';

INSERT INTO steps (id, workspace_id, campaign_version_id, position, step_key, action_type, channel,
  delay, step_template_hash, created_at)
VALUES ('stp_drill', :'workspace', 'cmv_drill', 1, 'connect', 'invite', 'linkedin',
  '{"anchor": "enrollment"}', 'drill-step-hash', now() - interval '21 days');

INSERT INTO approval_items (id, workspace_id, step_execution_id, person_id, sender_account_id,
  action_type, step_key, scheduled_for, status, approved_content_hash, decided_by, decided_at,
  decision_origin, updated_at)
VALUES ('apv_drill', :'workspace', 'sx_drill', 'per_drill', 'sac_drill', 'invite', 'connect',
  now() - interval '21 days', 'approved', 'drill-content-hash', :'owner',
  now() - interval '21 days', 'app', now());

-- inbox: the thread, the person's reply, its label and its classification, suggested, so that
-- campaigns acted on nothing.
INSERT INTO threads (id, workspace_id, channel, sender_account_id, owner_user_id, person_id,
  provider_thread_ref, last_message_at, updated_at)
VALUES ('thr_drill', :'workspace', 'linkedin', 'sac_drill', :'owner', 'per_drill', 'drill-chat',
  now() - interval '2 days', now());

INSERT INTO messages (id, workspace_id, thread_id, person_id, direction, body,
  provider_message_ref, sent_at, received_at)
VALUES ('msg_drill', :'workspace', 'thr_drill', 'per_drill', 'in', 'Thanks, not this quarter.',
  'drill-message', now() - interval '2 days', now() - interval '2 days');

-- The thread owner's label: the classifier's suggestion confirmed, beta's word following it
-- (gamma-p4-055).
INSERT INTO reply_labels (id, workspace_id, message_id, label, class_label, labeled_by, labeled_at)
VALUES ('rlb_drill', :'workspace', 'msg_drill', 'not_positive', 'not_now', :'owner',
  now() - interval '1 day');

INSERT INTO reply_classifications (id, workspace_id, message_id, thread_id, person_id, label,
  confidence, is_suggested, opt_out_detected, entities, origin, decision_record_id, model_id,
  prompt_version, actions_taken, created_at)
VALUES ('rcl_drill', :'workspace', 'msg_drill', 'thr_drill', 'per_drill', 'not_now', 0.62, true,
  false, '{"returnDate": null}', 'model', 'dec_drill', 'drill-model', 1,
  '{"actions": [], "enrollmentIds": []}', now() - interval '2 days');

-- linkedin: the outreach row, the reply's receipt (the daily job deletes those past 7 days), the
-- workspace's switch, off, and a health event whose owner was mailed.
INSERT INTO sender_outreach (id, workspace_id, sender_account_id, person_id, provider_member_ref,
  provider_chat_ref, invited_at, accepted_at, accepted_detected_at, last_sent_at, last_inbound_at,
  last_step_execution_id)
VALUES ('sor_drill', :'workspace', 'sac_drill', 'per_drill', 'drill-member', 'drill-chat',
  now() - interval '20 days', now() - interval '19 days', now() - interval '19 days',
  now() - interval '20 days', now() - interval '2 days', 'sx_drill');

INSERT INTO linkedin_event_receipts (id, event_key_hash, kind, received_at)
VALUES ('ler_drill', 'drill-event-key-hash', 'message.received', now() - interval '2 days');

INSERT INTO linkedin_workspace_controls (id, workspace_id, stopped, changed_by, changed_at)
VALUES ('lwc_drill', :'workspace', false, :'owner', now() - interval '3 days');

INSERT INTO sender_health_events (id, workspace_id, sender_id, from_state, to_state, trigger,
  owner_notified_at, created_at)
VALUES ('she_drill', :'workspace', 'sac_drill', 'healthy', 'disconnected', 'session_invalid',
  now() - interval '5 days', now() - interval '5 days');

-- qualification: the lead's intent row, intent 0 and no boost, which the nightly decay passes over
-- (gamma-p5-060).
INSERT INTO intent_scores (workspace_id, person_id, intent_score, priority, tier, intent_breakdown,
  why_now_event_id, boost_until, scorer_version, computed_at)
VALUES (:'workspace', 'per_drill', 0, 44, 'cool', '[]', NULL, NULL, 'intent-v1',
  now() - interval '2 days');

-- email (gamma-p1-010): the owner's sending domain, their mailbox, disconnected by them, its tokens
-- revoked and deleted, and its used connect row; no schedule acts on a disconnected mailbox.
INSERT INTO sending_domains (id, workspace_id, domain, created_at)
VALUES ('dom_drill', :'workspace', 'drill.example', now() - interval '10 days');

INSERT INTO mailboxes (id, workspace_id, owner_user_id, sending_domain_id, provider, email_address,
  display_name, scopes, oauth_token_ref, is_free_consumer, status, disconnected_reason, time_zone,
  connected_at, disconnected_at, token_checked_at)
VALUES ('mbx_drill', :'workspace', :'owner', 'dom_drill', 'google', 'owner@drill.example',
  'Drill Owner', '{send,read}', NULL, false, 'disconnected', 'user', 'UTC',
  now() - interval '10 days', now() - interval '3 days', now() - interval '10 days');

INSERT INTO mailbox_connects (id, workspace_id, user_id, provider, time_zone, state_hash,
  expires_at, used_at, created_at)
VALUES ('mcn_drill', :'workspace', :'owner', 'google', 'UTC', 'drill-state-hash',
  now() - interval '10 days' + interval '10 minutes', now() - interval '10 days',
  now() - interval '10 days');

-- approvals (gamma-p4-090): an email step's item from that mailbox, skipped by the owner, and a
-- follow-up's item the campaign's mode approved, by no person, its hash the frozen text's with the
-- AI disclosure line; their steps are made-up ids, so no schedule acts on them.
INSERT INTO approval_items (id, workspace_id, step_execution_id, person_id, mailbox_id,
  action_type, step_key, scheduled_for, status, decided_by, decided_at, decision_origin,
  updated_at)
VALUES ('apv_drill_email', :'workspace', 'sx_drill_email', 'per_drill', 'mbx_drill', 'email',
  'email_1', now() - interval '9 days', 'skipped', :'owner', now() - interval '9 days', 'app',
  now());

INSERT INTO approval_items (id, workspace_id, step_execution_id, person_id, sender_account_id,
  action_type, step_key, scheduled_for, status, approved_content_hash, decided_at,
  decision_origin, approval_by, updated_at)
VALUES ('apv_drill_mode', :'workspace', 'sx_drill_mode', 'per_drill', 'sac_drill', 'message',
  'follow_up_1', now() - interval '9 days', 'approved', 'drill-mode-content-hash',
  now() - interval '9 days', 'approval_mode', 'mode', now());

-- signals (sources-csv-import): a CSV file of sources the owner imported, whose one row was refused;
-- no source names it, and nothing acts on an import once it is recorded.
INSERT INTO signal_source_imports (id, workspace_id, file_name, created_by, created_at,
  created_count, disabled_count, refused_count)
VALUES ('simp_drill', :'workspace', 'drill-sources.csv', :'owner', now() - interval '3 days', 0, 0,
  1);

-- playbooks (gamma-p3-040): the owner's agent, active, on the workspace's default audience, and its
-- one source, a made-up id that matches no source of signals', so no schedule acts on it.
INSERT INTO playbooks (id, workspace_id, name, icp_id, owner_user_id, status, created_by,
  created_at, updated_at)
VALUES ('pbk_drill', :'workspace', 'Drill agent',
  (SELECT id FROM icps WHERE workspace_id = :'workspace' AND is_default), :'owner', 'active',
  :'owner', now() - interval '10 days', now() - interval '10 days');

INSERT INTO playbook_sources (id, workspace_id, playbook_id, source_id, created_at)
VALUES ('pbs_drill', :'workspace', 'pbk_drill', 'src_drill', now() - interval '10 days');

-- credits (gamma-p7-020): the workspace's organization's 80 percent alert of a past period, its mail
-- gone, to the owner (review-gaps-2); the check reads the current period's rows only.
INSERT INTO credit_alerts (id, organization_id, period_start, threshold, used, granted, notified_at,
  tries, created_at)
VALUES ('calert_drill', (SELECT organization_id FROM workspaces WHERE id = :'workspace'),
  '2026-09-01T00:00:00Z', 80, 8000000, 10000000, '2026-09-20T08:15:00Z', 0,
  '2026-09-20T08:00:00Z');

INSERT INTO credit_alert_mails (alert_id, user_id, mailed_at)
VALUES ('calert_drill', :'owner', '2026-09-20T08:15:00Z');

-- enrichment (gamma-en-050): the lead's new_lead run, done, which skipped the company the person
-- has none of; and the instance's counter of a source's calls on a past day. The tick acts on held
-- leads only, and a counter on its current period only.
INSERT INTO enrichment_runs (id, workspace_id, person_id, trigger, request_key, status,
  skip_reason, created_at, started_at, finished_at)
VALUES ('erun_drill', :'workspace', 'per_drill', 'new_lead', 'new_lead:per_drill', 'done',
  'no_company', now() - interval '21 days', now() - interval '21 days', now() - interval '21 days');

INSERT INTO source_usage (id, source, period_start, period, used, spent, updated_at)
VALUES ('susage_drill', 'company-data/fake', '2026-09-20', 'day', 1, false,
  '2026-09-20T08:00:00Z');

-- enrichment (gamma-en-080): the person's work address, verified again by a free re-verification
-- that ended found; its key's email entry for 120 days; and a domain found catch-all, for every
-- workspace. Ended requests only: nothing starts a lookup on its own.
INSERT INTO contact_points (id, workspace_id, person_id, kind, value, verification, verified_at,
  source_class, provider, acquired_at, legal_basis, status, created_at, updated_at)
VALUES ('cp_drill', :'workspace', 'per_drill', 'work_email', 'drill.lead@drill.example', 'valid',
  now() - interval '5 days', 'email_finder', 'fake', now() - interval '20 days',
  'legitimate_interest', 'active', now() - interval '20 days', now() - interval '5 days');

INSERT INTO enrichment_requests (id, workspace_id, person_id, trigger, request_key, status,
  attempt, providers_tried, contact_point_id, credits_charged, created_at, updated_at, finished_at)
VALUES ('enr_drill', :'workspace', 'per_drill', 'reverify', 'drill-reverify', 'found', 1,
  '[{"source":"email-verifier/fake","step":"verify","outcome":"valid","code":null,"ms":12}]',
  'cp_drill', 0, now() - interval '5 days', now() - interval '5 days', now() - interval '5 days');

INSERT INTO enrichment_cache_entries (id, workspace_id, key_hash, kind, value, verification,
  provider, retrieved_at, expires_at, person_id)
VALUES ('ecache_drill', :'workspace', repeat('d', 64), 'email', 'drill.lead@drill.example', 'valid',
  'fake', now() - interval '5 days', now() + interval '115 days', 'per_drill');

INSERT INTO email_domain_statuses (id, domain, catch_all, provider, checked_at, expires_at)
VALUES ('eds_drill', 'catch-all.example', true, 'fake', now() - interval '2 days',
  now() + interval '28 days');

-- contacts (gamma-rf-010): a shared company with an open-data fact, and the sharing group's row of
-- it with an import's. No company row of the workspace links to it, and no schedule writes either.
INSERT INTO companies (id, linkedin_url, industry, field_provenance, updated_at)
VALUES ('com_drill', 'https://linkedin.com/company/drill-co', 'Software',
  '{"industry":{"source":"open_data","provider":"fake","at":"2026-09-20T08:00:00.000Z"}}', now());

INSERT INTO group_companies (sharing_group_id, company_id, country, field_provenance, updated_at)
VALUES ((SELECT organization_id FROM workspaces WHERE id = :'workspace'), 'com_drill', 'DE',
  '{"country":{"source":"import","provider":"csv","at":"2026-09-20T08:00:00.000Z"}}', now());

-- enrichment (gamma-rf-030): a domain's address pattern, verified twice and seen on its site, for
-- every workspace. No schedule writes it: only a lookup's settle and the website source do.
INSERT INTO email_domain_patterns (domain, pattern, verified_count, last_verified_at, site_seen_at)
VALUES ('patterns.example', '{first}.{last}', 2, now() - interval '3 days',
  now() - interval '5 days');

-- contacts (gamma-rf-040): the person's email address, its keyed hash alone. No schedule writes it:
-- only a lookup's settle and emails:record do.
INSERT INTO person_email_hashes (workspace_id, person_id, hash)
VALUES (:'workspace', 'per_drill', 'drill-email-hash');

COMMIT;

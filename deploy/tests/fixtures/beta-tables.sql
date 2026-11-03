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
-- so qualification's tick passes it over), the change to replied, and a company's block.
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

-- campaigns and approvals: the enrollment, ended by the reply, its connection request sent, and
-- the request's approved item.
INSERT INTO enrollments (id, workspace_id, person_id, sender_account_id, template_id,
  template_version, status, source_event_id, started_at, ended_at, updated_at)
VALUES ('enl_drill', :'workspace', 'per_drill', 'sac_drill', 'linkedin_default', 1, 'replied',
  'evt_drill', now() - interval '21 days', now() - interval '2 days', now());

INSERT INTO step_executions (id, workspace_id, enrollment_id, person_id, sender_account_id,
  template_id, template_version, step_key, position, action_type, step_template_hash,
  idempotency_key, status, due_at, scheduled_for, quota_day, executed_at, attempt,
  approval_item_id, accepted_at, updated_at)
VALUES ('sx_drill', :'workspace', 'enl_drill', 'per_drill', 'sac_drill', 'linkedin_default', 1,
  'connect', 1, 'invite', 'drill-step-hash', 'drill-idempotency-key', 'succeeded',
  now() - interval '21 days', now() - interval '20 days', to_char(now() - interval '20 days',
  'YYYY-MM-DD'), now() - interval '20 days', 1, 'apv_drill', now() - interval '19 days', now());

INSERT INTO approval_items (id, workspace_id, step_execution_id, person_id, sender_account_id,
  action_type, step_key, scheduled_for, status, approved_content_hash, decided_by, decided_at,
  decision_origin, updated_at)
VALUES ('apv_drill', :'workspace', 'sx_drill', 'per_drill', 'sac_drill', 'invite', 'connect',
  now() - interval '21 days', 'approved', 'drill-content-hash', :'owner',
  now() - interval '21 days', 'app', now());

-- inbox: the thread, the person's reply and its label.
INSERT INTO threads (id, workspace_id, channel, sender_account_id, owner_user_id, person_id,
  provider_thread_ref, last_message_at, updated_at)
VALUES ('thr_drill', :'workspace', 'linkedin', 'sac_drill', :'owner', 'per_drill', 'drill-chat',
  now() - interval '2 days', now());

INSERT INTO messages (id, workspace_id, thread_id, person_id, direction, body,
  provider_message_ref, sent_at, received_at)
VALUES ('msg_drill', :'workspace', 'thr_drill', 'per_drill', 'in', 'Thanks, not this quarter.',
  'drill-message', now() - interval '2 days', now() - interval '2 days');

INSERT INTO reply_labels (id, workspace_id, message_id, label, labeled_by, labeled_at)
VALUES ('rlb_drill', :'workspace', 'msg_drill', 'not_positive', :'owner', now() - interval '1 day');

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

COMMIT;

// The PII class of every column of contacts' tables (docs/rules/security.md §2; data model §2.6):
// `business_contact` identifies or reaches a person in a professional role (a name, a headline or a
// title, an employer, a LinkedIn URL or member id, a location), `personal` is any other data about a
// person, `none` is not about a person. Every column but a `none` one carries `/// pii: <class>` in
// contacts.prisma, and its key is in the platform's PII registry, which the log redaction reads
// (tests/schema.test.ts proves both); the export rules read this map.
export type PiiClass = "none" | "business_contact" | "personal";

export const fields = {
  persons: {
    id: "none",
    workspace_id: "none",
    linkedin_url: "business_contact",
    provider_refs: "business_contact",
    first_name: "business_contact",
    last_name: "business_contact",
    headline: "business_contact",
    title: "business_contact",
    company_name: "business_contact",
    company_id: "none",
    location_text: "business_contact",
    location_country: "business_contact",
    field_provenance: "none",
    created_at: "none",
    updated_at: "none",
    last_touch_at: "none",
  },
  // A company's name and domain are firmographics; for a sole trader they name a person, which
  // the log redaction covers anyway (`name`).
  workspace_companies: {
    id: "none",
    workspace_id: "none",
    name: "none",
    domain: "none",
    linkedin_url: "none",
    industry: "none",
    size_range: "none",
    country: "none",
    provider_refs: "none",
    field_provenance: "none",
    created_at: "none",
    updated_at: "none",
  },
  // A hash is pseudonymous: whoever holds HASH_SALT and a URL can match it.
  person_hashes: {
    id: "none",
    workspace_id: "none",
    hash: "personal",
    kind: "none",
    drop_reasons: "none",
    created_at: "none",
    expires_at: "none",
  },
  // A lead copies none of the person's fields, which the list joins at read time; its why bullets
  // may quote the profile (alpha-p6-030's evidence), so they are classed as the profile is.
  leads: {
    person_id: "none",
    workspace_id: "none",
    qualification_status: "none",
    source_label: "none",
    sources: "none",
    first_source_at: "none",
    fit_score: "none",
    fit_confidence: "none",
    tier: "none",
    current_score_snapshot_id: "none",
    why: "business_contact",
    hard_filter_reason: "none",
    status_reason: "none",
    icp_version_scored: "none",
    created_at: "none",
    updated_at: "none",
    review_status: "none",
    reviewed_at: "none",
    outreach_status: "none",
    outreach_reason: "none",
  },
  // A decision's texts are the tester's words about the lead, which may quote the profile.
  review_decisions: {
    id: "none",
    workspace_id: "none",
    person_id: "none",
    decision: "none",
    reason_code: "none",
    reason_text: "business_contact",
    good_reason_text: "business_contact",
    snapshot_id: "none",
    fit_at_decision: "none",
    tier_at_decision: "none",
    decided_by: "none",
    decided_at: "none",
  },
  // A never-contact entry (beta-p2-010): its hash is pseudonymous, as person_hashes.hash; the profile
  // or company page it was typed with is a LinkedIn URL; a domain is a firmographic, as
  // workspace_companies.domain.
  suppression_entries: {
    id: "none",
    workspace_id: "none",
    layer: "none",
    match_type: "none",
    hash: "personal",
    linkedin_url: "business_contact",
    domain: "none",
    channel: "none",
    source: "none",
    reason: "none",
    created_by: "none",
    created_at: "none",
    removed_at: "none",
    removed_by: "none",
  },
  // A lead's outreach status change (beta-p2-030): statuses, codes and ids, nothing about the person.
  lead_status_changes: {
    id: "none",
    workspace_id: "none",
    person_id: "none",
    from_status: "none",
    to_status: "none",
    template_id: "none",
    reason: "none",
    actor_type: "none",
    actor_id: "none",
    created_at: "none",
  },
} as const satisfies Record<string, Record<string, PiiClass>>;

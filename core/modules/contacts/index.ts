// The public interface of contacts (README.md): the commands and queries other modules call, inside
// their own tenant run; the URL rule; the PII registry of its columns; the registries the hosts load;
// and `api`, the person and lead routes the api host mounts under
// /v1/workspaces/:workspaceId/contacts.
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2).
export { ContactsApi as api } from "./api/module.ts";
export {
  createLeadsForPersons,
  type LeadForPerson,
  type PersonUpsert,
  upsertPersonsFromSource,
} from "./domain/batch.ts";
export {
  type CompanyProfile,
  getCompany,
  linkPersonToCompany,
  refreshCompany,
  upsertCompany,
  type WorkspaceCompany,
} from "./domain/companies.ts";
export { PENDING_SNAPSHOTS_MAX, SOURCE_LABEL_MAX } from "./domain/constants.ts";
export { cleanLocation, countryCode, countryOf, namesNoPlace } from "./domain/countries.ts";
export {
  type EmailHolder,
  normalizeEmail,
  type RecordedEmail,
  recordPersonEmail,
} from "./domain/emails.ts";
export { csvLine } from "./domain/export/csv.ts";
export { fields, type PiiClass } from "./domain/fields.ts";
export type { HashKind } from "./domain/hash.ts";
export { isHashed, purgeExpiredHashes, recordHash } from "./domain/hashes.ts";
export { leadsHeldForEnrichment, releaseEnrichmentHold } from "./domain/hold.ts";
export {
  type Confidence,
  firstSignalSource,
  type LeadSort,
  type LeadSource,
  type QualificationStatus,
  type SourceKind,
  type Tier,
  type WhyBullet,
} from "./domain/lead.ts";
export {
  applyQualification,
  createLeadForPerson,
  getLead,
  type Lead,
  type LeadWithPerson,
  leadNeighbours,
  leadsPendingQualification,
  listLeads,
} from "./domain/leads.ts";
export { normalizeLinkedinUrl } from "./domain/linkedin-url.ts";
export type { OutreachStatus } from "./domain/outreach/constants.ts";
export type { StatusActor } from "./domain/outreach/rules.ts";
export {
  type LeadStatusChange,
  lockLeadStatus,
  recordLeadStatus,
} from "./domain/outreach/status.ts";
export { type CountryStamp, recordPersonCountry } from "./domain/person-country.ts";
export { findPersonsByNameAtCompany } from "./domain/person-match.ts";
export {
  type Colleague,
  colleaguesOf,
  erasePerson,
  findPersonByEmail,
  findPersonByLinkedinUrl,
  getPerson,
  type LockedPerson,
  listPersons,
  type Person,
  type PersonErasure,
  type PersonFromSource,
  type PersonName,
  type PersonProfile,
  personNames,
  upsertPersonFromSource,
} from "./domain/persons.ts";
export type { Provenance, ProvenanceMap, Provider, Source } from "./domain/provenance.ts";
export { type LatestReview, latestReviews } from "./domain/review/reviews.ts";
export type { SourceFilter } from "./domain/rules.ts";
export {
  type CheckOptions,
  lastTouchAt,
  recordTouch,
  suppressedAt,
  suppressionOf,
  suppressionsOf,
} from "./domain/suppression/checks.ts";
export {
  SUPPRESSION_BATCH_SIZE,
  type SuppressionChannel,
  type SuppressionLayer,
  type SuppressionReason,
  type SuppressionRelationship,
  type SuppressionSource,
} from "./domain/suppression/constants.ts";
export { type DomainStop, suppressedDomains } from "./domain/suppression/domains.ts";
export { type AddedEntry, addOptOut, type SuppressionEntry } from "./domain/suppression/entries.ts";
export type { Suppression } from "./domain/suppression/matching.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

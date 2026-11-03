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
  upsertCompany,
  type WorkspaceCompany,
} from "./domain/companies.ts";
export { countryOf } from "./domain/countries.ts";
export { fields, type PiiClass } from "./domain/fields.ts";
export type { HashKind } from "./domain/hash.ts";
export { isHashed, purgeExpiredHashes, recordHash } from "./domain/hashes.ts";
export type {
  Confidence,
  LeadSort,
  LeadSource,
  QualificationStatus,
  SourceKind,
  Tier,
  WhyBullet,
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
export {
  type Colleague,
  colleaguesOf,
  erasePerson,
  findPersonByLinkedinUrl,
  getPerson,
  listPersons,
  type Person,
  type PersonErasure,
  type PersonFromSource,
  type PersonProfile,
  upsertPersonFromSource,
} from "./domain/persons.ts";
export type { Provenance, ProvenanceMap, Provider, Source } from "./domain/provenance.ts";
export { type LatestReview, latestReviews } from "./domain/review/reviews.ts";
export {
  lastTouchAt,
  recordTouch,
  suppressedAt,
  suppressionOf,
} from "./domain/suppression/checks.ts";
export type {
  SuppressionLayer,
  SuppressionReason,
  SuppressionSource,
} from "./domain/suppression/constants.ts";
export { type AddedEntry, addOptOut, type SuppressionEntry } from "./domain/suppression/entries.ts";
export type { Suppression } from "./domain/suppression/matching.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

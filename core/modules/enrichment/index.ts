// The public interface of enrichment (README.md "Public interface"): `api`, the lead page's routes
// the api host mounts under /v1/workspaces/:workspaceId/enrichment; a run on request, a person's
// last run and the sources a run asked, the erasure of a person's rows, the definition of a source
// for the later tasks' sources, the email lookup's requests, readers and bounce (gamma-en-080), its cleaner of a name (gamma-wr-070), the lookup for a name that is not a person yet (gamma-wr-080), the
// slot for inbox's reader of the addresses a person gave (gamma-en-085), the test for a company's website among a search's results (gamma-wr-046), the reader of a company's site with the caller's own page limit (gamma-wr-050), and the registries. Nothing
// else in this module is importable from outside it (docs/rules/coding.md §2).
export { EnrichmentApi as api } from "./api/module.ts";
export { erasePerson } from "./domain/erase.ts";
export { addressOf, markBounced, workEmailOf } from "./domain/lookup/addresses.ts";
export { normalName } from "./domain/lookup/key.ts";
export {
  type NameAsk,
  type NameDeps,
  type NameNone,
  type NameResult,
  workAddressOfName,
} from "./domain/lookup/name.ts";
export {
  type LookupTrigger,
  type RequestStatus,
  requestLookup,
  requestReverification,
} from "./domain/lookup/request.ts";
export { cleanPhone, samePhone } from "./domain/phone/form.ts";
export { keepPhone, type PhoneOutcome } from "./domain/phone/keep.ts";
export type { SourceTried } from "./domain/plan.ts";
export { type LastRun, lastRunOf, sourcesTried } from "./domain/readers.ts";
export { requestEnrichment } from "./domain/request.ts";
export {
  defineSource,
  type EmailCandidate,
  type EmailSourceAnswer,
  type EmailSourceDefinition,
  type EmailSourceInput,
  type SourceAnswer,
  type SourceContext,
  type SourceDefinition,
  type SourceFacts,
  type SourceInput,
} from "./domain/sources/define.ts";
export { type AddressesGiven, useAddressesGiven } from "./domain/sources/reply.ts";
export {
  domainOf,
  isNotAHomepage,
  type Picked,
  pickWebsite,
} from "./domain/sources/web-search/pick.ts";
export { readCompanySite, type SiteReadOptions } from "./domain/sources/website/site.ts";
export { searchWeb, type WebSearched } from "./domain/web-search.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { prices } from "./prices.ts";
export { settings } from "./settings.ts";

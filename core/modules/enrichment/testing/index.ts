// What tests reach of enrichment (README "Testing"): the client of the module's own runs, its clock,
// the sources' lists in place of the settings', a run written as the batch or a request writes one,
// in the caller's tenant run, the website source's local site, and the `ai` sources' callAgent
// options; the email lookup's lists, and a contact point and a cache entry written as a settle
// writes them (gamma-en-080).
export { useClock } from "../domain/clock.ts";
export {
  keepAddress as createContactPoint,
  writeCache as createCacheEntry,
} from "../domain/lookup/points.ts";
export { useEmailLists } from "../domain/lookup/sources.ts";
export { usePersonalEmailEuUk } from "../domain/lookup/switch.ts";
export { createRun } from "../domain/runs.ts";
export { useAgentCall } from "../domain/sources/agent-call.ts";
export { useSourceLists } from "../domain/sources/index.ts";
export { useSiteHome } from "../domain/sources/website/site.ts";
export { useClient as useEnrichmentClient } from "../domain/store.ts";
export { useWebSearchAdapters } from "../domain/web-search.ts";

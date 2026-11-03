// The public interface of onboarding (README.md "Public interface"): the reads other modules call
// and their types, the registries the hosts load, and `api`, the routes the api host mounts under
// /v1/workspaces/:workspaceId/onboarding. Nothing else in this module is importable from outside it
// (docs/rules/coding.md §2).
export { OnboardingApi as api } from "./api/company-knowledge.controller.ts";
export {
  type CompanyKnowledge,
  getCompanyDomain,
  readCompanyKnowledge,
} from "./domain/commands.ts";
export type { ContentField, FetchStatus, FieldSource, ProofPoint } from "./domain/fields.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

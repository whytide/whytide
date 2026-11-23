// The public interface of signals (README.md): the api the host mounts under
// /v1/workspaces/:workspaceId/signals, the events other modules subscribe to, the person's erasure
// the deletion script calls, the runs that read a person for credits' cost counter (alpha-p10-010),
// and the registries the hosts load, its price among them. Loading it registers every source kind
// (sources/registry.ts), qualification's signal reader (domain/register-reader.ts) and playbooks'
// source checker (domain/register-checker.ts).
// Nothing else in this module is importable from outside it (docs/rules/coding.md §2); the worker
// loads workflows/ itself.
import "./domain/register-checker.ts";
import "./domain/register-reader.ts";

export { SignalsApi as api } from "./api/sources.controller.ts";
export { erasePerson, listEvidence } from "./domain/evidence.ts";
export { type PersonRead, personReads } from "./domain/person-reads.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";
export { prices } from "./prices.ts";
export { settings } from "./settings.ts";

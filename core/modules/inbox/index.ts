// The public interface of inbox (README.md): `api`, the routes the api host mounts under
// /v1/workspaces/:workspaceId/inbox; the addresses a person gave in their messages, enrichment's
// `reply` source's reader (gamma-en-085); the eraser privacy's deletion script runs, the event
// inbox.reply_received, and the registries the hosts load, with the subscription to linkedin's
// messages. Nothing else in this module is importable from outside it (docs/rules/coding.md §2);
// the worker loads workflows/ itself.
export { InboxApi as api } from "./api/module.ts";
export { addressesGivenBy } from "./domain/addresses/given.ts";
export { erasePerson } from "./domain/erase.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

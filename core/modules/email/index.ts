// The public interface of email (README.md): the api the host mounts under
// /v1/workspaces/:workspaceId/email, the mailbox read and the disconnects other modules call, the
// types of the worker's withMailboxTokens (the tokens it hands over and its answer), the constants,
// the events other modules subscribe to, and the registries the hosts load. Nothing else in this
// module is importable from outside it (docs/rules/coding.md §2); the worker loads workflows/ itself.
export { EmailApi as api } from "./api/mailboxes.controller.ts";
export { CONNECT_STATE_TTL_MS, FREE_CONSUMER_DOMAINS } from "./domain/constants.ts";
export {
  type DisconnectReason,
  disconnectMailbox,
  findMailbox,
  type Mailbox,
  markTokenRevoked,
} from "./domain/mailboxes.ts";
export type { MailboxTokens, TokensAnswer } from "./domain/provider.ts";
export { errors } from "./errors.ts";
export { events } from "./events.ts";
export { ids } from "./ids.ts";
export { permissions } from "./permissions.ts";

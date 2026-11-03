// The principal (architecture §5; coding §4): who a request or a background job runs for. The api
// host's guard builds a human principal from the session and, once identity resolves the membership
// in the URL's workspace (alpha-p3-030), fills the workspace, the membership and the role; the worker
// and the seeder run as a service principal, internal code that no request can produce. can() in
// ../permissions decides from it; the tenant transaction (alpha-p1-045) writes userId to app.user_id.
import { AppError, defineErrors } from "../errors/index.ts";

/** Agents join in Core 1.1. */
export type ActorType = "human" | "service";
/** API keys and OAuth tokens join in Core 1.1. */
export type AuthMethod = "session" | "internal";
export type Role = "Owner" | "Admin" | "Member";

export type Principal = {
  /** The user the request acts for; `service:<name>` for a service principal. */
  readonly userId: string;
  readonly actorType: ActorType;
  readonly authMethod: AuthMethod;
  /** Set by the guard once the membership is resolved; absent on a non-member and on a service. */
  readonly membershipId?: string;
  readonly workspaceId?: string;
  readonly role?: Role;
  /** Carried for the API keys and agents of Core 1.1; not evaluated in alpha. */
  readonly scopes: readonly string[];
};

const errors = defineErrors({ invalid_service_name: {} });
const SERVICE_NAME = /^[a-z][a-z0-9_]*$/;

/** The worker's or the seeder's principal: built in process, never from a request; frozen. */
export function servicePrincipal(name: string): Principal {
  if (!SERVICE_NAME.test(name)) {
    throw new AppError(errors.invalid_service_name, { details: { service: name } });
  }
  const principal: Principal = {
    userId: `service:${name}`,
    actorType: "service",
    authMethod: "internal",
    scopes: Object.freeze([]),
  };
  return Object.freeze(principal);
}

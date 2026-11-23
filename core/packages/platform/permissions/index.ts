// The permission function and its policy table (architecture §5; coding §3): one table assembled
// from every module's permissions.ts, one function every host asks before a module command runs, so
// no handler decides access on its own. A member may do an action whose registered roles hold the
// member's role (gamma-p6-010); scopes, the deny list and agents' owner ceiling are Core 1.1's.
import { AppError, defineErrors } from "../errors/index.ts";
import type { Principal, Role } from "../principal/index.ts";

export type PermissionDefinition = { readonly action: string; readonly roles: readonly Role[] };
export type RegisteredPermission = { readonly roles: readonly Role[]; readonly source: string };
/** The workspace an action touches: a principal bound to another workspace is forbidden. */
export type PermissionResource = { readonly workspaceId: string };
export type PermissionDecision = "allow" | "forbidden" | "unknown_action";
type Actions<T extends readonly PermissionDefinition[]> = {
  readonly [A in T[number]["action"]]: A;
};

/** The codes can() answers with and the registry throws at start; the api host maps them. */
export const permissionErrors = defineErrors({
  forbidden: { status: 403 },
  unknown_action: {},
  invalid_permission_action: {},
  invalid_permission_definition: {},
  duplicate_permission_action: {},
});

const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const ROLES: readonly Role[] = ["Owner", "Admin", "Member"];
const registry = new Map<string, RegisteredPermission>();

/**
 * Registers a module's actions from its permissions.ts; `source` is the file registering them, its
 * `import.meta.url`, so an action two modules declare fails at start naming both files. The shape is
 * checked at run time as well, as defineIds and defineErrors do, so a cast or a list read from JSON
 * fails at start with a code, never later with a TypeError. Returns the actions as themselves, so
 * `permissions["leads.read"]` is typed.
 */
export function definePermissions<const T extends readonly PermissionDefinition[]>(
  definitions: T,
  source: string,
): Actions<T> {
  if (typeof source !== "string" || source === "") {
    throw new AppError(permissionErrors.invalid_permission_definition, {
      details: { field: "source" },
    });
  }
  for (const { action, roles } of definitions) {
    if (!ACTION.test(action)) {
      throw new AppError(permissionErrors.invalid_permission_action, {
        details: { action, source },
      });
    }
    if (!Array.isArray(roles) || !roles.every((role) => ROLES.includes(role))) {
      throw new AppError(permissionErrors.invalid_permission_definition, {
        details: { action, source, field: "roles" },
      });
    }
    const existing = registry.get(action);
    if (existing) {
      throw new AppError(permissionErrors.duplicate_permission_action, {
        details: { action, sources: [existing.source, source] },
      });
    }
    registry.set(action, Object.freeze({ roles: Object.freeze([...roles]), source }));
  }
  const actions = definitions.map(({ action }) => [action, action]);
  return Object.freeze(Object.fromEntries(actions)) as Actions<T>;
}

export const registeredPermissions = (): ReadonlyMap<string, RegisteredPermission> => registry;

/**
 * The one decision: `allow`, or the code the host answers with; it never throws for a principal. An
 * action no module registered is `unknown_action`, a bug in the caller, whoever asks. A principal
 * bound to a workspace is forbidden another workspace's resource, service or human. A service
 * principal, internal code, may then do any registered action. A human needs a membership, which a
 * host checks against the URL's workspace by passing it as the resource, and last a role the action
 * lists: an action registered with no roles is a service's only. Scopes wait for Core 1.1.
 */
export function can(
  principal: Principal,
  action: string,
  resource?: PermissionResource,
): PermissionDecision {
  const permission = registry.get(action);
  if (!permission) return permissionErrors.unknown_action;
  if (resource && principal.workspaceId && resource.workspaceId !== principal.workspaceId) {
    return permissionErrors.forbidden;
  }
  if (principal.actorType === "service" && principal.authMethod === "internal") return "allow";
  if (!principal.membershipId || !principal.workspaceId || !principal.role) {
    return permissionErrors.forbidden;
  }
  if (!permission.roles.includes(principal.role)) return permissionErrors.forbidden;
  return "allow";
}

/**
 * A row a member owns (gamma-p6-015): its owner's user id, null when the workspace owns it (made
 * before the owner was recorded, or by the worker), and the module's action that writes another
 * member's rows, its `<module>.manage`.
 */
export type OwnedRow = { readonly ownerUserId: string | null; readonly manageAction: string };

/**
 * Whether the principal may write a row a member owns: `allow` for whoever `can()` allows the manage
 * action (the roles it lists, and the service) and for the row's owner, a member here; `forbidden`
 * otherwise, so a row with no owner is the manage action's only. An unregistered manage action is
 * `unknown_action`, a bug in the caller, even for the owner. It reads nothing and throws nothing: the
 * host has checked the route's own action, and the module throws a refusal before it writes.
 */
export function canWriteOwned(principal: Principal, row: OwnedRow): PermissionDecision {
  const manage = can(principal, row.manageAction);
  if (manage !== permissionErrors.forbidden) return manage;
  const member = Boolean(principal.membershipId && principal.workspaceId && principal.role);
  const owns = member && Boolean(row.ownerUserId) && row.ownerUserId === principal.userId;
  return owns ? "allow" : permissionErrors.forbidden;
}

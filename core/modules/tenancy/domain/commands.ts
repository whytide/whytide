// tenancy's commands and queries (README.md "Public interface"), each on one path of store.ts. A
// relation is never queried: each model is read on its own and joined here (core/packages/db README).
import { outboxWriter } from "@whytide/db";
import { AppError, newId, publish, type Role } from "@whytide/platform";
import { errors } from "../errors.ts";
import { events } from "../events.ts";
import { ids } from "../ids.ts";
import {
  addMemberInput,
  bootstrapInput,
  createWorkspaceInput,
  findOrganizationBySlugInput,
  findUserByEmailInput,
  isSlug,
  parseInput,
  requireId,
  resolveMembershipInput,
  upsertUserInput,
} from "./rules.ts";
import { inGlobal, inWorkspace, membershipsOfUser } from "./store.ts";

export type User = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly locale: string | null;
  readonly createdAt: Date;
  readonly disabledAt: Date | null;
};
export type Organization = {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
};
export type Workspace = {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
  readonly createdAt: Date;
};
export type Membership = {
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly role: Role;
  readonly createdAt: Date;
};
/** A membership with its workspace and organization, as GET /v1/me lists them. */
export type MembershipListing = {
  readonly membershipId: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly role: Role;
};

/** A unique index refused the write (P2002): another request wrote the row first. */
const isUniqueViolation = (error: unknown) =>
  (error as { code?: unknown } | null)?.code === "P2002";

/**
 * `write`, run once more when a unique index refused it: Prisma's upsert reads, then creates, so the
 * second of two first creations at once fails; run again, it finds the first one's row.
 */
async function onceMore<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return write();
  }
}

/**
 * The user with the email, created when there is none; `displayName`, when given, is set either way.
 * Two calls at once for a new email make one user.
 */
export async function upsertUser(input: { email: string; displayName?: string }): Promise<User> {
  const { email, displayName } = parseInput(upsertUserInput, input);
  return onceMore(() =>
    inGlobal((db) =>
      db.user.upsert({
        where: { email },
        create: { id: newId(ids.user), email, displayName: displayName ?? null },
        update: displayName === undefined ? {} : { displayName },
      }),
    ),
  );
}

/** The user, or null. */
export async function findUser(userId: string): Promise<User | null> {
  const id = requireId("userId", userId);
  return inGlobal((db) => db.user.findUnique({ where: { id } }));
}

/** The user with the email, lowercased and checked as upsertUser does, or null; it creates nothing. */
export async function findUserByEmail(email: string): Promise<User | null> {
  const input = parseInput(findUserByEmailInput, { email });
  return inGlobal((db) => db.user.findUnique({ where: { email: input.email } }));
}

/**
 * The user with `disabled_at` set, the authentication adapter's revokeUser (through identity): set
 * once, a second call keeps the first time. user_not_found when no user has the id.
 */
export async function disableUser(userId: string): Promise<User> {
  const id = requireId("userId", userId);
  return inGlobal(async (db) => {
    await db.user.updateMany({ where: { id, disabledAt: null }, data: { disabledAt: new Date() } });
    const user = await db.user.findUnique({ where: { id } });
    if (user === null) throw new AppError(errors.user_not_found);
    return user;
  });
}

/** The workspace, or null; `organizationId` names its organization. */
export async function findWorkspace(workspaceId: string): Promise<Workspace | null> {
  const id = requireId("workspaceId", workspaceId);
  return inGlobal((db) => db.workspace.findUnique({ where: { id } }));
}

/** The organization, or null: signals reads its name for the own-employee rule (alpha-p8-030). */
export async function findOrganization(organizationId: string): Promise<Organization | null> {
  const id = requireId("organizationId", organizationId);
  return inGlobal((db) => db.organization.findUnique({ where: { id } }));
}

/** The organization with the slug, or null: identity's tenant commands. */
export async function findOrganizationBySlug(slug: string): Promise<Organization | null> {
  const input = parseInput(findOrganizationBySlugInput, { slug });
  return inGlobal((db) => db.organization.findUnique({ where: { slug: input.slug } }));
}

/** Whether any organization exists: identity's `pnpm invite` bootstraps the first one otherwise. */
export async function hasOrganization(): Promise<boolean> {
  const found = await inGlobal((db) => db.organization.findFirst({ select: { id: true } }));
  return found !== null;
}

/**
 * A new organization, its workspace and the owner's Owner membership in one transaction: a run in the
 * new workspace, whose client writes the global rows too. Both take `name`; the organization takes
 * the workspace's slug, so a second call with the slug is organization_exists and writes nothing,
 * also when it loses a race between the check and the insert. The event
 * tenancy.organization_created, ids only, is written in the same transaction (credits subscribes).
 */
export async function bootstrapOrganization(input: {
  name: string;
  workspaceSlug: string;
  ownerUserId: string;
}): Promise<{ organization: Organization; workspace: Workspace; membership: Membership }> {
  const { name, workspaceSlug: slug, ownerUserId } = parseInput(bootstrapInput, input);
  const workspaceId = newId(ids.workspace);
  try {
    return await inWorkspace(workspaceId, async (tx) => {
      if ((await tx.user.findUnique({ where: { id: ownerUserId } })) === null) {
        throw new AppError(errors.user_not_found);
      }
      if ((await tx.organization.findUnique({ where: { slug } })) !== null) {
        throw new AppError(errors.organization_exists);
      }
      const organization = await tx.organization.create({
        data: { id: newId(ids.organization), name, slug },
      });
      const workspace = await tx.workspace.create({
        data: { id: workspaceId, organizationId: organization.id, name, slug },
      });
      const membership = await tx.membership.create({
        data: { id: newId(ids.membership), workspaceId, userId: ownerUserId, role: "Owner" },
      });
      const created = { organizationId: organization.id, workspaceId };
      await publish(outboxWriter(tx, workspaceId), events["tenancy.organization_created"], created);
      return { organization, workspace, membership };
    });
  } catch (error) {
    // P2002, the unique slug: another bootstrap committed between the check and the insert.
    if (isUniqueViolation(error)) {
      throw new AppError(errors.organization_exists);
    }
    throw error;
  }
}

/**
 * Another workspace of an organization and the owner's Owner membership, in one transaction: a run
 * in the new workspace, as bootstrapOrganization's. The slug must be free in the organization, or
 * it is workspace_exists and writes nothing, also when another call wins the race between the check
 * and the insert. No event: credits are the organization's, so the workspace spends its balance.
 */
export async function createWorkspace(input: {
  organizationId: string;
  name: string;
  slug: string;
  ownerUserId: string;
}): Promise<{ workspace: Workspace; membership: Membership }> {
  const { organizationId, name, slug, ownerUserId } = parseInput(createWorkspaceInput, input);
  const workspaceId = newId(ids.workspace);
  try {
    return await inWorkspace(workspaceId, async (tx) => {
      if ((await tx.organization.findUnique({ where: { id: organizationId } })) === null) {
        throw new AppError(errors.organization_not_found);
      }
      if ((await tx.user.findUnique({ where: { id: ownerUserId } })) === null) {
        throw new AppError(errors.user_not_found);
      }
      const named = { organizationId_slug: { organizationId, slug } };
      if ((await tx.workspace.findUnique({ where: named })) !== null) {
        throw new AppError(errors.workspace_exists);
      }
      const workspace = await tx.workspace.create({
        data: { id: workspaceId, organizationId, name, slug },
      });
      const membership = await tx.membership.create({
        data: { id: newId(ids.membership), workspaceId, userId: ownerUserId, role: "Owner" },
      });
      return { workspace, membership };
    });
  } catch (error) {
    // P2002, the unique (organization_id, slug): another call committed after the check.
    if (isUniqueViolation(error)) throw new AppError(errors.workspace_exists);
    throw error;
  }
}

/**
 * The user's membership of the workspace with the role, created when there is none; one there is is
 * kept as it is, its role included. Two calls at once make one membership.
 */
export async function addMember(input: {
  userId: string;
  workspaceId: string;
  role: Role;
}): Promise<Membership> {
  const { userId, workspaceId, role } = parseInput(addMemberInput, input);
  return onceMore(() =>
    inWorkspace(workspaceId, async (tx) => {
      if ((await tx.workspace.findUnique({ where: { id: workspaceId } })) === null) {
        throw new AppError(errors.workspace_not_found);
      }
      if ((await tx.user.findUnique({ where: { id: userId } })) === null) {
        throw new AppError(errors.user_not_found);
      }
      return tx.membership.upsert({
        where: { workspaceId_userId: { workspaceId, userId } },
        create: { id: newId(ids.membership), workspaceId, userId, role },
        update: {},
      });
    }),
  );
}

/** addMember with the role Owner. */
export function addOwner(input: { userId: string; workspaceId: string }): Promise<Membership> {
  return addMember({ ...input, role: "Owner" });
}

/** The user's memberships in every workspace, oldest first, each with its workspace and organization. */
export async function listMemberships(userId: string): Promise<MembershipListing[]> {
  const memberships = await membershipsOfUser(userId);
  if (memberships.length === 0) return [];
  return inGlobal(async (db) => {
    const workspaceIds = memberships.map((membership) => membership.workspaceId);
    const workspaces = await db.workspace.findMany({ where: { id: { in: workspaceIds } } });
    const orgIds = workspaces.map((workspace) => workspace.organizationId);
    const organizations = await db.organization.findMany({ where: { id: { in: orgIds } } });
    const workspaceOf = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
    const nameOf = new Map(organizations.map((org) => [org.id, org.name]));
    return memberships.flatMap(({ id, workspaceId, role }) => {
      const workspace = workspaceOf.get(workspaceId);
      const organizationName = workspace && nameOf.get(workspace.organizationId);
      if (!workspace || organizationName === undefined) return []; // the foreign keys forbid it
      const { slug, name, organizationId } = workspace;
      const listing = { membershipId: id, workspaceId, slug, name, organizationId, role };
      return [{ ...listing, organizationName }];
    });
  });
}

/**
 * The user's membership of the workspace a URL names, by its id or its slug, or null. Read from the
 * user's own memberships, so no other user's row; a slug two of them share, in two organizations,
 * names none.
 */
export async function resolveMembership(input: {
  userId: string;
  workspaceIdOrSlug: string;
}): Promise<Membership | null> {
  const { userId, workspaceIdOrSlug: named } = parseInput(resolveMembershipInput, input);
  const memberships = await membershipsOfUser(userId);
  const byId = memberships.find((membership) => membership.workspaceId === named);
  if (byId !== undefined) return byId;
  if (memberships.length === 0 || !isSlug(named)) return null;
  const workspaceIds = memberships.map((membership) => membership.workspaceId);
  const workspaces = await inGlobal((db) =>
    db.workspace.findMany({ where: { id: { in: workspaceIds }, slug: named } }),
  );
  const [only, ...more] = workspaces;
  if (only === undefined || more.length > 0) return null;
  return memberships.find((membership) => membership.workspaceId === only.id) ?? null;
}

/**
 * The workspace with the slug, or null when none has it or workspaces of two organizations do, which
 * a slug alone cannot tell apart: the caller passes the id then (identity's invite command).
 */
export async function findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  if (!isSlug(slug)) {
    throw new AppError(errors.tenancy_input_invalid, { details: { fields: ["slug"] } });
  }
  const found = await inGlobal((db) => db.workspace.findMany({ where: { slug }, take: 2 }));
  return found.length === 1 ? (found[0] ?? null) : null;
}

/** Every workspace's id, by id: the fan-out of global work to one run per workspace. Ids only. */
export async function listWorkspaceIds(): Promise<string[]> {
  const rows = await inGlobal((db) =>
    db.workspace.findMany({ select: { id: true }, orderBy: { id: "asc" } }),
  );
  return rows.map((row) => row.id);
}

// tenancy's fixed values for the members (gamma-p6-030; README.md "Members"), beside the code that
// reads them: the commands, permissions.ts and the members screen.

/** The roles a member's role changes between; Admin is zeta's. */
export const MEMBER_ROLES = ["Owner", "Member"] as const;

/** Who lists the members' role menus and Remove, and may change a role or remove a member. */
export const MEMBERS_MANAGE_ROLES = ["Owner"] as const;

/** The locale the member list orders names in, so the order is one on every server. */
export const NAME_ORDER_LOCALE = "en";

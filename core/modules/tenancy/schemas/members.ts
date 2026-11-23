// The members routes' input and answers (README.md "Members"), from which the api's OpenAPI document
// and the web's client are generated: the list, a member, and the body of a role change.
import { z } from "zod";
import { MEMBER_ROLES } from "../domain/constants.ts";

export const memberParams = z.strictObject({ membershipId: z.string().min(1).max(64) });

/** Owner or Member: the route refuses Admin, as changeRole does (validation_failed, `role`). */
export const changeRoleBody = z.strictObject({ role: z.enum(MEMBER_ROLES) });
export type ChangeRoleBody = z.infer<typeof changeRoleBody>;

export const memberResponse = z.strictObject({
  membershipId: z.string(),
  userId: z.string(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(["Owner", "Admin", "Member"]),
  joinedAt: z.iso.datetime(),
  /** The caller's own row: no one changes their own role or removes themselves. */
  isSelf: z.boolean(),
});
export type MemberResponse = z.infer<typeof memberResponse>;
export const memberListResponse = z.strictObject({ members: z.array(memberResponse) });

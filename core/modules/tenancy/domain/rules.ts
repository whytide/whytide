// The rules of tenancy's inputs (docs/concepts.md): a slug, an email as it is stored, a name. The
// commands parse their input with these, and settings.ts checks WORKSPACE_SLUG with the same slug.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";

const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * A slug, the workspace in a URL: 2 to 40 lowercase letters, digits and single dashes inside, starting
 * with a letter (`acme`, `sales-emea-2`). It never looks like an id, which has an underscore.
 */
export function isSlug(value: string): boolean {
  return value.length >= 2 && value.length <= 40 && SLUG.test(value);
}

export const slug = z.string().refine(isSlug, "2 to 40 lowercase letters, digits and dashes");
/** An email as users stores it: trimmed and lowercased, 254 characters at most, as the auth port. */
export const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
/** An organization's, a workspace's or a user's name. */
export const name = z.string().trim().min(1).max(100);
const id = z.string().min(1);
const role = z.enum(["Owner", "Admin", "Member"]);

export const upsertUserInput = z.strictObject({ email, displayName: name.optional() });
export const findUserByEmailInput = z.strictObject({ email });
export const bootstrapInput = z.strictObject({ name, workspaceSlug: slug, ownerUserId: id });
export const createWorkspaceInput = z.strictObject({
  organizationId: id,
  name,
  slug,
  ownerUserId: id,
});
export const findOrganizationBySlugInput = z.strictObject({ slug });
export const addMemberInput = z.strictObject({ userId: id, workspaceId: id, role });
export const resolveMembershipInput = z.strictObject({ userId: id, workspaceIdOrSlug: id });

/** An id argument, a non-empty string, or tenancy_input_invalid naming `field`. */
export function requireId(field: string, value: unknown): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw new AppError(errors.tenancy_input_invalid, { details: { fields: [field] } });
}

/** The input as the schema reads it, or tenancy_input_invalid naming the fields at fault, no value. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields = [...new Set(result.error.issues.map((issue) => issue.path.map(String).join(".")))];
  throw new AppError(errors.tenancy_input_invalid, { details: { fields } });
}

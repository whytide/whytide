// The answer of GET /v1/me (README.md "GET /v1/me"), from which alpha-p2-020 generates the OpenAPI
// document: the user, every workspace they belong to with their role in it, and the feedback link.
import { z } from "zod";

export const meResponse = z.strictObject({
  user: z.strictObject({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    locale: z.string().nullable(),
  }),
  memberships: z.array(
    z.strictObject({
      workspaceId: z.string(),
      slug: z.string(),
      name: z.string(),
      organizationName: z.string(),
      role: z.enum(["Owner", "Admin", "Member"]),
    }),
  ),
  /** FEEDBACK_URL (settings.ts), the web header's feedback link; null when it is unset. */
  feedbackUrl: z.url().nullable(),
});
export type MeResponse = z.infer<typeof meResponse>;

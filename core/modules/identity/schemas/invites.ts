// The invites routes' input and answers (README.md "Invites"), from which the api's OpenAPI document
// and the web's client are generated: the Invites screen's list, invite and revoke, and the
// Invitations page's list and accept. No answer carries a token or a link that signs in. Nothing here
// reads settings.ts: the document is the same whatever the environment sets (README "Settings").
import { z } from "zod";
import {
  EMAIL_INPUT_MAX,
  ID_INPUT_MAX,
  INVITE_OPEN_DAYS,
  INVITE_ROLES,
} from "../domain/constants.ts";

const role = z.enum(["Owner", "Admin", "Member"]);

export const inviteParams = z.strictObject({ id: z.string().min(1).max(ID_INPUT_MAX) });

/**
 * The email as typed, which createInvite trims, lowercases and checks (identity_input_invalid,
 * `email`); Owner or Member, the route refusing Admin before it (validation_failed, `role`).
 */
export const createInviteBody = z.strictObject({
  email: z.string().max(EMAIL_INPUT_MAX),
  role: z.enum(INVITE_ROLES),
});
export type CreateInviteBody = z.infer<typeof createInviteBody>;

export const inviteResponse = z.strictObject({
  id: z.string(),
  email: z.string(),
  role,
  /** Read when answered: open until expiresAt, unless revoked. */
  state: z.enum(["open", "expired", "revoked"]),
  /** The user who invited or renewed it; null for `pnpm invite`. */
  invitedBy: z.string().nullable(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  /** When its last mail went; null until one did since it was made or renewed. */
  mailedAt: z.iso.datetime().nullable(),
});
export type InviteResponse = z.infer<typeof inviteResponse>;
export const inviteListResponse = z.strictObject({
  invites: z.array(inviteResponse),
  ttlDays: z
    .number()
    .int()
    .describe(
      `The days an invite stays open after it is made or renewed, as the server is configured, ${INVITE_OPEN_DAYS.default} by default`,
    ),
});
export type InviteListResponse = z.infer<typeof inviteListResponse>;

/** The invite, and its mail: sent, skipped while the app has no public origin, or failed. */
export const createInviteResponse = z.strictObject({
  invite: inviteResponse,
  mail: z.enum(["sent", "skipped", "failed"]),
  /** The app-mail port's code, for a failed mail only. */
  mailCode: z.string().optional(),
});
export type CreateInviteResponse = z.infer<typeof createInviteResponse>;

/** An open invite as its invitee sees it: no email, the session's own. */
export const invitationResponse = z.strictObject({
  id: z.string(),
  workspaceName: z.string(),
  role,
  /** The inviter's display name or email; null for `pnpm invite`. */
  invitedByName: z.string().nullable(),
  expiresAt: z.iso.datetime(),
});
export type InvitationResponse = z.infer<typeof invitationResponse>;
export const invitationListResponse = z.strictObject({
  invitations: z.array(invitationResponse),
});

/** The workspace an accepted invite joined, where the page goes next: /w/<slug>. */
export const acceptResponse = z.strictObject({ workspaceId: z.string(), slug: z.string() });
export type AcceptResponse = z.infer<typeof acceptResponse>;

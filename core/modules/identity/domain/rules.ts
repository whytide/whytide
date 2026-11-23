// The rules of identity's input and invites (docs/concepts.md): an email as invites store it, as
// tenancy's users and the authentication port do; the role an invite gives; when an invite is open,
// and what inviting an email again does. How long it stays open is IDENTITY_INVITE_TTL_DAYS
// (settings.ts, README "Settings").
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";
import { settings } from "../settings.ts";
import { DAY_MS, INVITE_ROLES, type InviteRole } from "./constants.ts";

/** How long an invite stays open after it is made or renewed: IDENTITY_INVITE_TTL_DAYS. */
export const INVITE_TTL_MS = settings.IDENTITY_INVITE_TTL_DAYS * DAY_MS;

/** Trimmed, lowercased, 254 characters at most. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const role = z.enum(INVITE_ROLES);

/** The email as stored, or null when the value is not one. */
export function normalizeEmail(value: unknown): string | null {
  const result = email.safeParse(value);
  return result.success ? result.data : null;
}

/** The email as stored, or identity_input_invalid naming the field, never the value. */
export function requireEmail(value: unknown): string {
  const normalized = normalizeEmail(value);
  if (normalized !== null) return normalized;
  throw new AppError(errors.identity_input_invalid, { details: { fields: ["email"] } });
}

/** Owner or Member; anything else, Admin included, is identity_input_invalid naming `role`. */
export function requireRole(value: unknown): InviteRole {
  const result = role.safeParse(value);
  if (result.success) return result.data;
  throw new AppError(errors.identity_input_invalid, { details: { fields: ["role"] } });
}

/** An id argument, a non-empty string, or invite_not_found: an empty id names no invite. */
export function requireInviteId(value: unknown): string {
  if (typeof value === "string" && value !== "") return value;
  throw new AppError(errors.invite_not_found);
}

/** What an invite's dates say of it. */
export type InviteDates = {
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
};
export type InviteState = "open" | "expired" | "revoked" | "accepted";

/**
 * An invite is open while it is not accepted, not revoked and before its expiry, read at `at`, the
 * moment of use: nothing rewrites an expired row.
 */
export function inviteState(invite: InviteDates, at: Date): InviteState {
  if (invite.acceptedAt !== null) return "accepted";
  if (invite.revokedAt !== null) return "revoked";
  return invite.expiresAt.getTime() > at.getTime() ? "open" : "expired";
}

/** The expiry of an invite made or renewed at `at`. */
export const expiryFrom = (at: Date): Date => new Date(at.getTime() + INVITE_TTL_MS);

export type InviteDecision = "create" | "renew" | "invite_exists" | "already_member";

/**
 * What inviting an email does, in this order: an open invite is invite_exists; an active member of
 * the workspace is already_member; any other row, expired, revoked, or accepted by a member removed
 * since, is renewed; no row, a new invite.
 */
export function decideInvite(
  existing: InviteDates | null,
  activeMember: boolean,
  at: Date,
): InviteDecision {
  if (existing !== null && inviteState(existing, at) === "open") return "invite_exists";
  if (activeMember) return "already_member";
  return existing === null ? "create" : "renew";
}

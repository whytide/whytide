// The rule of identity's input (docs/concepts.md): an email as invites store it, as tenancy's users
// and the authentication port do.
import { AppError } from "@whytide/platform";
import { z } from "zod";
import { errors } from "../errors.ts";

/** Trimmed, lowercased, 254 characters at most. */
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());

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

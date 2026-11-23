// The bodies and answers of the accounts routes (README.md "API"), from which the api host builds the
// OpenAPI document. The times, days and zone are checked by domain/working-hours.ts, which answers
// working_hours_invalid, so their shapes stay loose here.
import { z } from "zod";

const timeZone = z.string().min(1).max(64);
const workingHours = z.strictObject({
  /** `HH:MM`, local to the zone. */
  start: z.string().max(5),
  end: z.string().max(5),
  /** ISO days, 1 for Monday to 7 for Sunday. */
  days: z.array(z.int()).max(7),
});
const status = z.enum(["pending", "connected", "credentials_required", "error", "disconnected"]);
/**
 * Who holds a stop: the tester, through the screen, or the operator, through the command; an
 * account's alone, a member's removal, which only the account's owner lifts.
 */
export const switchSource = z.enum(["tester", "operator", "member_removed"]);

export const connectBody = z.strictObject({
  /** The browser's IANA zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone,
  /** The risk disclosure read and accepted; anything but true is disclosure_required. */
  acknowledged: z.boolean(),
  /** The disclosure's version the screen showed; anything but DISCLOSURE_VERSION is disclosure_required. */
  disclosureVersion: z.int().optional(),
  /** The account is the user's own personal one; anything but true is personal_account_required. */
  personalAccount: z.boolean().optional(),
});
export type ConnectBody = z.infer<typeof connectBody>;
export const connectResponse = z.strictObject({ url: z.url() });

export const updateAccountBody = z.strictObject({
  label: z.string().trim().min(1).max(100).optional(),
  timeZone: timeZone.optional(),
  workingHours: workingHours.optional(),
  /**
   * The reads a day at most: a whole number from 1 to LINKEDIN_DAILY_READ_CAP_MAX. The domain checks
   * it and answers read_cap_invalid, so a fraction or a string passes here; a refused value is
   * neither stored nor echoed.
   */
  dailyReadCap: z.union([z.number(), z.string()]).optional(),
});
export type UpdateAccountBody = z.infer<typeof updateAccountBody>;

export const accountParams = z.strictObject({ id: z.string().min(1).max(64) });

export const disclosureBody = z.strictObject({
  /** The disclosure's version the screen showed: DISCLOSURE_VERSION, else disclosure_version_invalid. */
  version: z.int(),
  /** The account is the owner's own personal one: true, else personal_account_required. */
  personalAccount: z.boolean(),
});
export type DisclosureBody = z.infer<typeof disclosureBody>;

export const accountResponse = z.strictObject({
  id: z.string(),
  label: z.string(),
  status,
  timeZone: z.string(),
  workingHours,
  dailyReadCap: z.int(),
  /** The account is the signed-in user's own. */
  mine: z.boolean(),
  /** Its owner's name, else their email, among the workspace's members; null once they were removed. */
  ownerName: z.string().nullable(),
  /** The signed-in user holds linkedin.manage (an Owner): sees and pauses every member's account. */
  canManage: z.boolean(),
  /** The signed-in user may relabel, refresh and disconnect it, and accept its disclosure: its owner. */
  canEdit: z.boolean(),
  /** Not paused, and the signed-in user may pause it: its owner or a holder of linkedin.manage. */
  canPause: z.boolean(),
  /** Paused, and the signed-in user may lift that pause: a tester's, its owner or a holder of linkedin.manage; a removed member's, its owner; the operator's, no one. */
  canUnpause: z.boolean(),
  /** Paused (its kill switch): no LinkedIn action through it, reads included. */
  paused: z.boolean(),
  /** Who paused it, null while it is not paused: only the operator lifts the operator's pause. */
  pausedBy: switchSource.nullable(),
  /** The risk disclosure's version its owner accepted: 1, alpha's, covers reads only. */
  disclosureVersion: z.int(),
  /** No send until its owner accepts the current disclosure with the personal-account confirmation. */
  sendingDisclosureRequired: z.boolean(),
});
export type AccountResponse = z.infer<typeof accountResponse>;
export const accountListResponse = z.strictObject({ accounts: z.array(accountResponse) });

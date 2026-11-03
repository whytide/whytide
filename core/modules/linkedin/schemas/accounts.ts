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

export const connectBody = z.strictObject({
  /** The browser's IANA zone, `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  timeZone,
  /** The risk disclosure read and accepted; anything but true is disclosure_required. */
  acknowledged: z.boolean(),
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

export const accountResponse = z.strictObject({
  id: z.string(),
  label: z.string(),
  status,
  timeZone: z.string(),
  workingHours,
  dailyReadCap: z.int(),
  /** The account is the signed-in user's own. */
  mine: z.boolean(),
  /** The signed-in user holds linkedin.manage: may change, refresh and disconnect the account. */
  canManage: z.boolean(),
});
export type AccountResponse = z.infer<typeof accountResponse>;
export const accountListResponse = z.strictObject({ accounts: z.array(accountResponse) });

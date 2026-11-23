// identity's fixed values for invites (gamma-p6-020; README.md "Invites"), beside the code that
// reads them: the commands, the mail, the routes' schemas and the screens, and the default of the
// invites' open days settings.ts reads (README "Settings"), which the screens never use: they show
// the days the invites' list answers. No import: the screens read this file.

/**
 * IDENTITY_INVITE_TTL_DAYS's default (settings.ts, README "Settings"): the days an invite stays open
 * after it is made or renewed, unset 7 (not in the sources); set, 1 or more, no maximum.
 */
export const INVITE_OPEN_DAYS = { default: 7 } as const;

/** A day of an invite's expiry, in milliseconds. */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** The roles an invite gives; Admin is zeta's. */
export const INVITE_ROLES = ["Owner", "Member"] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** The invites' list in the api, which the Invites screen reads the open days from. */
export const INVITES_PATH = "/v1/workspaces/{workspaceId}/identity/invites";

/** The page the invite mail links to, after APP_PUBLIC_ORIGIN: the invitee's open invites. */
export const INVITATIONS_PATH = "/invitations";

/** The variable the mail's link starts with: the web app's origin. */
export const ORIGIN_VARIABLE = "APP_PUBLIC_ORIGIN";

/** The day the mail says the invite expires: a long date, in UTC, the invitee's zone being unknown. */
export const MAIL_DATE_FORMAT: Intl.DateTimeFormatOptions = { dateStyle: "long", timeZone: "UTC" };

/** The longest name a mail carries, the workspace's or the inviter's: tenancy's names are 100. */
export const MAIL_NAME_MAX = 100;

/** The longest strings the routes read, before the rules check them. */
export const EMAIL_INPUT_MAX = 320;
export const ID_INPUT_MAX = 64;

/** How long the Invites screen's toast stays: the mail's outcome is a sentence to read. */
export const TOAST_MS = 5_000;

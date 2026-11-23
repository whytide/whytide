// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8):
// LINKEDIN_DAILY_READ_CAP_MAX, declared in config.ts, and the note budget,
// LINKEDIN_INVITE_NOTES_PER_MONTH (env-settings-a), read once as the module loads, so that a value
// that is not an integer of 1 or more stops the start with config_invalid. The adapter is the
// providers' PROVIDER_LINKEDIN, the hosted link's return address the api's APP_PUBLIC_ORIGIN, and
// the webhook's public URL the unipile adapter's UNIPILE_NOTIFY_URL (README.md "Settings").
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { INVITE_NOTES_PER_MONTH } from "./domain/send/constants.ts";

export { linkedinConfig as settings } from "./config.ts";

export const noteSettings = defineConfig("modules/linkedin", {
  /** Invitations with a note one account sends in 30 days, 1 or more, no maximum (README.md). */
  LINKEDIN_INVITE_NOTES_PER_MONTH: z.coerce
    .number()
    .int()
    .positive()
    .default(INVITE_NOTES_PER_MONTH.default),
});

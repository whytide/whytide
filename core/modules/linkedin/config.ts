// linkedin's block of deploy/.env.example (README.md "Settings"): the highest daily read cap an
// account may be given through PATCH /accounts/{id} (domain/accounts.ts), at most READS_PER_DAY_MAX,
// a hard maximum of domain/quota/constants.ts that no setting raises: a value above it stops the
// start with config_invalid. The default cap stays sender_accounts' 100; a lower bound set later
// changes no account's cap, only the next change. LINKEDIN_HASH_KEY keys the hashes of a LinkedIn
// member id and of a provider event's key (domain/hash.ts): optional, so that importing the module
// never throws (env:create leaves a secret empty); without it no member id is stored, so no account
// sends (member_id_unknown), and the receiver keeps no event. LINKEDIN_ALERT_EMAIL is the operator's
// address for the fleet breaker's mail (domain/health/mail.ts): empty, the breaker still trips and
// the worker logs linkedin_alert_email_missing instead. LINKEDIN_COMPANY_READS_PER_DAY is the share
// of an account's daily reads that company pages may take (gamma-en-060, domain/company/read.ts),
// counted inside those reads: 0 turns company reads off. LINKEDIN_CONTACT_INFO_ENABLED, `false` by
// default, lets an email lookup read the email addresses a lead shows its 1st-degree connections in
// "Contact info" (gamma-en-087, domain/contact/): the owner's exception of 2026-11-13 to the rule
// against reading that section, for now, to be turned off later. Off, no read is made; nothing
// found earlier is deleted.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";
import { COMPANY_READS_PER_DAY_DEFAULT, READS_PER_DAY_MAX } from "./domain/quota/constants.ts";

export const linkedinConfig = defineConfig("modules/linkedin", {
  /** The highest daily read cap, 1 to READS_PER_DAY_MAX (100). */
  LINKEDIN_DAILY_READ_CAP_MAX: z.coerce
    .number()
    .int()
    .min(1)
    .max(READS_PER_DAY_MAX)
    .default(READS_PER_DAY_MAX),
  /** The key of the member ids' and the event keys' HMAC, 32 characters or more, kept for good. */
  LINKEDIN_HASH_KEY: secret(z.string().min(32).optional()),
  /** The operator's address for the fleet breaker's mail; empty: no mail, a log line. */
  LINKEDIN_ALERT_EMAIL: z.email().optional(),
  /** The most `read_company` reads an account makes in a quota day, 0 to READS_PER_DAY_MAX; 0: none. */
  LINKEDIN_COMPANY_READS_PER_DAY: z.coerce
    .number()
    .int()
    .min(0)
    .max(READS_PER_DAY_MAX)
    .default(COMPANY_READS_PER_DAY_DEFAULT),
  /** Contact info's emails read for an email lookup (the owner's exception, 2026-11-13); off by default. */
  LINKEDIN_CONTACT_INFO_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

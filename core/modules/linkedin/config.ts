// linkedin's block of deploy/.env.example (README.md "Settings"): the highest daily read cap an
// account may be given through PATCH /accounts/{id} (domain/accounts.ts). The default cap stays
// sender_accounts' 100; a lower bound set later changes no account's cap, only the next change.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";

export const linkedinConfig = defineConfig("modules/linkedin", {
  /** The highest daily read cap, 1 to 1,000. */
  LINKEDIN_DAILY_READ_CAP_MAX: z.coerce.number().int().min(1).max(1_000).default(250),
});

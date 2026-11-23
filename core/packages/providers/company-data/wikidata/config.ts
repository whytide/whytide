// The wikidata adapter's variables (README.md "Variables"), in the providers block of
// deploy/.env.example: the contact Wikimedia's User-Agent policy asks for, an email address or an
// https page, and the free allowance, empty, since Wikidata has none. The contact is optional here,
// so that reading the block never throws for it: create() requires it.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import { allowance } from "../../_pattern/index.ts";
import { CONTACT, CONTACT_MAX } from "./constants.ts";

export const wikidataConfig = defineConfig("packages/providers", {
  WIKIDATA_CONTACT: z
    .string()
    .max(CONTACT_MAX)
    .regex(CONTACT, "an email address or an https page")
    .optional(),
  WIKIDATA_ALLOWANCE: allowance(),
});

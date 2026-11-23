// The settings this module reads, its block of deploy/.env.example (docs/rules/coding.md §3, §8):
// HASH_SALT, declared in config.ts, the limits of an exclusion list's CSV (gamma-p2-045; README.md
// "Settings"), how long a new lead waits for enrichment (gamma-en-040; README.md "Enrichment's
// hold"), the classes whose company facts every organization reads (gamma-rf-010; README.md
// "Shared companies") and the days a recent touch refuses a new enrollment (env-settings-a;
// README.md "Settings"), each read once as the module loads, so that a value off its range stops
// the start with config_invalid.
import { defineConfig } from "@whytide/platform";
import { z } from "zod";
import {
  SHAREABLE_CLASSES,
  SHARED_CLASSES_DEFAULT,
  type ShareableClass,
} from "./domain/companies/constants.ts";
import { HOLD_MINUTES_DEFAULT, HOLD_MINUTES_MAX } from "./domain/constants.ts";
import {
  IMPORT_MAX_BYTES_DEFAULT,
  IMPORT_MAX_BYTES_LIMIT,
  IMPORT_MAX_ROWS_DEFAULT,
  IMPORT_MAX_ROWS_LIMIT,
} from "./domain/exclusions/constants.ts";
import { RECENT_TOUCH_DAYS } from "./domain/suppression/constants.ts";

export { contactsConfig as settings } from "./config.ts";

export const exclusionSettings = defineConfig("modules/contacts", {
  /** Data rows an exclusion list's file may hold, the header aside; the next one stops the reading. */
  EXCLUSIONS_IMPORT_MAX_ROWS: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMPORT_MAX_ROWS_LIMIT)
    .default(IMPORT_MAX_ROWS_DEFAULT),
  /** Bytes an exclusion list's file may hold; the next one stops the reading. */
  EXCLUSIONS_IMPORT_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(IMPORT_MAX_BYTES_LIMIT)
    .default(IMPORT_MAX_BYTES_DEFAULT),
});

export const holdSettings = defineConfig("modules/contacts", {
  /** Minutes a new lead waits for enrichment before its first judgement (domain/hold.ts); 0, none. */
  CONTACTS_ENRICHMENT_HOLD_MINUTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(HOLD_MINUTES_MAX)
    .default(HOLD_MINUTES_DEFAULT),
});

export const touchSettings = defineConfig("modules/contacts", {
  /** Days a person's last outbound touch refuses a new enrollment, 1 or more, no maximum. */
  CONTACTS_RECENT_TOUCH_DAYS: z.coerce.number().int().positive().default(RECENT_TOUCH_DAYS.default),
});

/**
 * Classes separated by commas, each once, each one of SHAREABLE_CLASSES; any other is refused, so the
 * host stops at start. Unset, SHARED_CLASSES_DEFAULT; empty, or commas and spaces only, no class.
 */
function sharedClasses() {
  const shareable = (name: string): name is ShareableClass =>
    (SHAREABLE_CLASSES as readonly string[]).includes(name);
  return z
    .string()
    .optional()
    .transform((value, context): readonly ShareableClass[] => {
      if (value === undefined) return Object.freeze([...SHARED_CLASSES_DEFAULT]);
      const names = value
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      if (!names.every(shareable) || new Set(names).size !== names.length) {
        context.addIssue({
          code: "custom",
          message: `classes among ${SHAREABLE_CLASSES.join(", ")}, each once`,
        });
        return z.NEVER;
      }
      return Object.freeze(names);
    });
}

const SHARED = "CONTACTS_SHARED_FACT_SOURCES";
const shared = process.env[SHARED];

export const sharingSettings = defineConfig(
  "modules/contacts",
  {
    /** The classes whose company facts every organization reads (domain/companies/sharing.ts). */
    CONTACTS_SHARED_FACT_SOURCES: sharedClasses(),
  },
  // Empty is a list of no class here, not unset as defineConfig reads an empty value: an operator who
  // empties the line stops every fact from crossing organizations. A lone comma carries it.
  { [SHARED]: shared === "" ? "," : shared },
);

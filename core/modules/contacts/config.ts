// contacts' block of deploy/.env.example (README.md "Settings"): HASH_SALT keys the hashes that are
// all that is left of rejected candidates and erased people (domain/hash.ts). Optional here, so that
// importing the module never throws (env:create leaves a secret empty); the first hash checks it.
import { defineConfig, secret } from "@whytide/platform";
import { z } from "zod";

export const contactsConfig = defineConfig("modules/contacts", {
  HASH_SALT: secret(z.string().min(32).optional()),
});

// The master keys of secrets at rest, in the platform's block of deploy/.env.example (README "Secrets
// at rest"): APP_MASTER_KEY wraps every data key; APP_MASTER_KEY_PREVIOUS, set during a rotation,
// only unwraps. Both are optional here so that importing the package never throws: a host without a
// key starts and fails at its first secret, or at start when it calls loadMasterKeys(); the format is
// checked there, where the message can name the variable.
import { z } from "zod";
import { defineConfig, secret } from "../config/define.ts";

export const secretsConfig = defineConfig("packages/platform", {
  APP_MASTER_KEY: secret(z.string().optional()),
  APP_MASTER_KEY_PREVIOUS: secret(z.string().optional()),
});

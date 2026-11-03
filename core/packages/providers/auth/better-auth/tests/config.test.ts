// The adapter refuses to start while one of Better Auth's own variables is set (README.md "Vendor
// and terms"): each would replace its secret, base URL or trusted origins, or turn telemetry on.
// The refusal comes before anything else, the database included.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAppError } from "@whytide/platform";
import { betterAuthAdapter } from "../index.ts";

const VARIABLES = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_SECRETS",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_TELEMETRY",
  "BETTER_AUTH_TELEMETRY_ENDPOINT",
];

test("the adapter refuses to start while a BETTER_AUTH_* variable is set, naming it, not its value", () => {
  for (const name of VARIABLES) {
    process.env[name] = "https://evil.example";
    try {
      assert.throws(
        () => betterAuthAdapter.create(),
        (error) => {
          assert.ok(isAppError(error) && error.code === "config_invalid", name);
          assert.match(JSON.stringify(error.details), new RegExp(`${name}:`));
          assert.doesNotMatch(JSON.stringify([error.message, error.details]), /evil/);
          return true;
        },
      );
    } finally {
      delete process.env[name];
    }
  }
});

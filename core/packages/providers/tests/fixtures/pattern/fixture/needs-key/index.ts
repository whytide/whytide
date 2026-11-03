// A fixture adapter that needs a credential: its contract suite is skipped, never failed, while
// FIXTURE_API_KEY is empty.
import { defineAdapter } from "../../../../../_pattern/index.ts";
import { greeter } from "../echo/index.ts";
import { fixturePort } from "../port.ts";

export const needsKeyAdapter = defineAdapter(fixturePort, {
  name: "needs-key",
  requires: ["FIXTURE_API_KEY"],
  create: greeter,
});

// A fixture adapter no test file imports: tests/registry.test.ts reaches it through a loader, the way
// registry.generated.ts loads the one adapter PROVIDER_<PORT> names, and nothing else is loaded.
import { defineAdapter } from "../../../../../_pattern/index.ts";
import { greeter } from "../echo/index.ts";
import { fixturePort } from "../port.ts";

export const lazyAdapter = defineAdapter(fixturePort, { name: "lazy", create: greeter });

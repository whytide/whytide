// Loading this file registers signals' source checker with playbooks (source-checker.ts;
// gamma-p5-045), as register-reader.ts registers the reader with qualification: index.ts imports it,
// and so do events.ts and workflows/index.ts, which the worker loads from dist/ without index.ts. A
// module is evaluated once per process, so the checker is registered once.
import { defineSourceChecker } from "@whytide/playbooks";
import { checkSources } from "./source-checker.ts";

defineSourceChecker((sourceIds) => checkSources(sourceIds));

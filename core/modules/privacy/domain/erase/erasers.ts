// The erasers the deletion script runs (README.md "Erasers"), each the function a module's or a
// package's index.ts exports for it, registered here as privacy loads: no module imports privacy.
// Contacts' erasePerson is not among them: it runs after them all, as the script's last step
// (erase.ts), since it deletes the person and leaves the erased hash. test:tenancy fails on a tenant
// table with a person_id whose module is neither here nor contacts (tests/tenancy.test.ts).
import { eraseDecisionRecords } from "@whytide/ai";
import { erasePerson as eraseDrafts } from "@whytide/messaging";
import { erasePerson as eraseAssessments } from "@whytide/qualification";
import { erasePerson as eraseEvents } from "@whytide/signals";
import { erasePlatformRows } from "./platform.ts";
import { defineEraser, registeredErasers } from "./registry.ts";

/** The module whose eraser runs last, outside the registry: the person's own. */
export const LAST = "contacts";

// A snapshot and a draft name their model calls' decision records, so theirs go before ai's.
defineEraser({ module: "ai", dependsOn: [], erase: eraseDecisionRecords });
defineEraser({ module: "messaging", dependsOn: ["ai"], erase: eraseDrafts });
defineEraser({ module: "platform", dependsOn: [], erase: erasePlatformRows });
defineEraser({ module: "qualification", dependsOn: ["ai"], erase: eraseAssessments });
defineEraser({ module: "signals", dependsOn: [], erase: eraseEvents });

/** Every module whose rows the script erases: the registered ones, then contacts. */
export function erasingModules(): string[] {
  return [...registeredErasers().map((eraser) => eraser.module), LAST];
}

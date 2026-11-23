// The erasers the deletion script runs (README.md "Erasers"), each the function a module's or a
// package's index.ts exports for it, registered here as privacy loads: no module imports privacy.
// Contacts' erasePerson is not among them: it runs after them all, as the script's last step
// (erase.ts), since it deletes the person and leaves the erased hash. test:tenancy fails on a tenant
// table with a person_id whose module is neither here nor contacts (tests/tenancy.test.ts).
import { eraseDecisionRecords } from "@whytide/ai";
import { erasePerson as eraseApprovalItems } from "@whytide/approvals";
import { erasePerson as eraseEnrollments } from "@whytide/campaigns";
import { erasePerson as eraseRuns } from "@whytide/enrichment";
import { erasePerson as eraseThreads } from "@whytide/inbox";
import { erasePerson as eraseOutreach } from "@whytide/linkedin";
import { erasePerson as eraseDrafts } from "@whytide/messaging";
import { erasePerson as eraseAssessments } from "@whytide/qualification";
import { erasePerson as eraseEvents } from "@whytide/signals";
import { erasePlatformRows } from "./platform.ts";
import { defineEraser, registeredErasers } from "./registry.ts";

/** The module whose eraser runs last, outside the registry: the person's own. */
export const LAST = "contacts";

/** The module whose eraser runs first, before the run locks the lead (erase.ts). */
export const FIRST = "platform";

// A snapshot, a draft, a rated event and a reply's classification name their model calls' decision
// records, so theirs go before ai's. An outbox event a delivery holds makes the platform's step wait
// for that delivery's commit, so campaigns' runs after it and erases the enrollment a
// contacts.lead_approved delivery just wrote. The run puts the platform's step first of all, before
// it locks the lead, which that delivery locks too (erase.ts): no module's rows may name the
// platform's (tests/order.test.ts).
defineEraser({ module: "ai", dependsOn: [], erase: eraseDecisionRecords });
defineEraser({ module: "approvals", dependsOn: [], erase: eraseApprovalItems });
defineEraser({ module: "campaigns", dependsOn: [], erase: eraseEnrollments });
defineEraser({ module: "enrichment", dependsOn: [], erase: eraseRuns });
defineEraser({ module: "inbox", dependsOn: ["ai"], erase: eraseThreads });
defineEraser({ module: "linkedin", dependsOn: [], erase: eraseOutreach });
defineEraser({ module: "messaging", dependsOn: ["ai"], erase: eraseDrafts });
defineEraser({ module: "platform", dependsOn: ["campaigns"], erase: erasePlatformRows });
defineEraser({ module: "qualification", dependsOn: ["ai"], erase: eraseAssessments });
defineEraser({ module: "signals", dependsOn: ["ai"], erase: eraseEvents });

/** Every module whose rows the script erases: the registered ones, then contacts. */
export function erasingModules(): string[] {
  return [...registeredErasers().map((eraser) => eraser.module), LAST];
}

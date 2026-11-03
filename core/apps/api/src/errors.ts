// The host's own codes (README "Errors"), developer-facing: no message keys. A module's are its own.
import { defineErrors } from "@whytide/platform";

export const hostErrors = defineErrors({
  /** A body, a parameter or a query off its schema; `details.fields` lists the paths at fault. */
  validation_failed: { status: 400 },
  /** Anything but an AppError or an HTTP error: the log line has its type and frames, the answer none. */
  internal_error: { status: 500 },
  /** A workspace route whose handler declares no @Permission: refused rather than left open. */
  permission_undeclared: { status: 500 },
  /** The workspaceResolver answered something other than a membership or null. */
  workspace_resolver_invalid: { status: 500 },
  /** A migration failed at start; `details.migration` names it. */
  migration_failed: { status: 500 },
  /** At start, a module export the host cannot register: `details.module` and `details.field`. */
  module_invalid: { status: 500 },
  /** At start, a health check or the workspaceResolver registered twice: `details.sources`. */
  duplicate_registration: { status: 500 },
});

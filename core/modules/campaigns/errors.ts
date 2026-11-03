// campaigns' codes (core/packages/platform/README.md "Errors"), each with its key in messages/en.json:
// none yet. The panel and the queue bring the first; a code a writer is given and its list does not
// hold is a developer's mistake, thrown as one (domain/steps/codes.ts).
import { defineErrors } from "@whytide/platform";

export const errors = defineErrors({});

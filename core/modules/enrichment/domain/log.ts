// The logger of the module's warnings: the worker host's, which onWorkerStart hands over
// (workflows/index.ts), else one of its own. A line carries a source's name and a code, never a value.
import { createLogger, type Logger } from "@whytide/platform";

let given: Logger | undefined;
let own: Logger | undefined;

export function useLog(next: Logger | undefined): void {
  given = next;
}

export const log = (): Logger => given ?? (own ??= createLogger());

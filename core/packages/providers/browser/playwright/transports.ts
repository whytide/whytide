// The page's side of the fences (README.md "The fences"): an init script, run in every document,
// frames and popups included, before its own scripts, that takes from it what would send UDP past
// the route filter and the dead proxy (constants.ts REMOVED_GLOBALS). Each name is left undefined,
// and no script can put it back.

/** The init script: self-contained, since Playwright sends its source. */
export function removeTransports(names: readonly string[]): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  for (let at = 0; at < names.length; at += 1) {
    Reflect.defineProperty(scope, `${names[at]}`, {
      value: undefined,
      writable: false,
      configurable: false,
    });
  }
}

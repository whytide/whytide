// PROVIDER_<PORT> (docs/rules/coding.md §6 rule 3, §8): the server variable that names the adapter a
// port runs on, `fake` in development and tests. A port declares its own in `<port>/config.ts`
// through defineConfig("packages/providers", { PROVIDER_LLM: providerSelector() }), written out so
// that `pnpm env:check` reads it, and hands the value to getAdapter(), which checks it against the
// registry: the list of adapters lives there, never in the schema.
import { z } from "zod";

export const ADAPTER_NAME = /^[a-z][a-z0-9-]*$/;

/** The schema of a `PROVIDER_<PORT>` variable: an adapter folder name. Optional, so that importing the package never throws; getAdapter() fails on `undefined`. */
export function providerSelector() {
  return z.string().regex(ADAPTER_NAME, "an adapter folder name").optional();
}

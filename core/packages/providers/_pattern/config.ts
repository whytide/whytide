// PROVIDER_<PORT> (docs/rules/coding.md §6 rule 3, §8): the server variable that names the adapter a
// port runs on, `fake` in development and tests. A port declares its own in `<port>/config.ts`
// through defineConfig("packages/providers", { PROVIDER_LLM: providerSelector() }), written out so
// that `pnpm env:check` reads it, and hands the value to getAdapter(), which checks it against the
// registry: the list of adapters lives there, never in the schema. A port whose caller asks several
// vendors in turn takes a list instead, providerList(), which getAdapters() loads in its order; each
// of its adapters reads its free allowance from its own <ADAPTER>_ALLOWANCE, allowance() (README.md
// "Many adapters per port").
import { z } from "zod";
import {
  ALLOWANCE,
  ALLOWANCE_MAX_CALLS,
  ALLOWANCE_MIN_CALLS,
  type ALLOWANCE_PERIODS,
  PROVIDER_LIST_SEPARATOR,
} from "./constants.ts";

export const ADAPTER_NAME = /^[a-z][a-z0-9-]*$/;

/** The period an allowance renews over: a calendar day or month, in UTC. */
export type AllowancePeriod = (typeof ALLOWANCE_PERIODS)[number];
/** A vendor's free calls per period: `100/day` is `{ calls: 100, per: "day" }`. */
export type Allowance = { readonly calls: number; readonly per: AllowancePeriod };

/** The schema of a `PROVIDER_<PORT>` variable: an adapter folder name. Optional, so that importing the package never throws; getAdapter() fails on `undefined`. */
export function providerSelector() {
  return z.string().regex(ADAPTER_NAME, "an adapter folder name").optional();
}

/**
 * The schema of a `PROVIDER_<PORT>` variable that lists adapters: folder names separated by commas,
 * no space, in the order given, each once. Empty or unset (defineConfig reads an empty value as
 * unset) is none, `[]`, so that importing the package never throws.
 */
export function providerList() {
  return z
    .string()
    .optional()
    .transform((value, context): readonly string[] => {
      if (value === undefined) return Object.freeze([]);
      const names = value.split(PROVIDER_LIST_SEPARATOR);
      if (!names.every((name) => ADAPTER_NAME.test(name))) {
        context.addIssue({ code: "custom", message: "adapter folder names separated by commas" });
        return z.NEVER;
      }
      if (new Set(names).size !== names.length) {
        context.addIssue({ code: "custom", message: "an adapter named twice" });
        return z.NEVER;
      }
      return Object.freeze(names);
    });
}

/**
 * The schema of an `<ADAPTER>_ALLOWANCE` variable: `<count>/day` or `<count>/month`, the count
 * ALLOWANCE_MIN_CALLS to ALLOWANCE_MAX_CALLS, parsed to `{ calls, per }`; empty or unset, `null`:
 * no allowance, no limit. Anything else fails at start, as every config value does.
 */
export function allowance() {
  return z
    .string()
    .optional()
    .transform((value, context): Allowance | null => {
      if (value === undefined) return null;
      const [, count, per] = ALLOWANCE.exec(value) ?? [];
      const calls = Number(count);
      if (per === undefined || calls < ALLOWANCE_MIN_CALLS || calls > ALLOWANCE_MAX_CALLS) {
        const message = `<count>/day or <count>/month, the count ${ALLOWANCE_MIN_CALLS} to ${ALLOWANCE_MAX_CALLS}`;
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return Object.freeze({ calls, per: per as AllowancePeriod });
    });
}

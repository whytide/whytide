// A source's next fire times (README.md "API"), which the sources screen shows: the instants its
// kind's schedule gives from the save (for post_engagers at save, then three and seven days later)
// that come after its last run, all of them before its first, the next one first. A disabled source
// has none, and so has one whose kind is no longer registered.
import { registeredSourceKinds } from "../sources/registry.ts";

export type FireTimes = { readonly fireTimes: readonly Date[]; readonly nextRunAt: Date | null };

const NONE: FireTimes = { fireTimes: [], nextRunAt: null };

export function fireTimes(source: {
  readonly kind: string;
  readonly config: unknown;
  readonly createdAt: Date;
  readonly enabled: boolean;
  readonly lastRunAt: Date | null;
}): FireTimes {
  const kind = registeredSourceKinds().get(source.kind);
  if (!source.enabled || kind === undefined) return NONE;
  const after = source.lastRunAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const times = kind
    .schedule(source.config, source.createdAt)
    .filter((at) => at.getTime() > after)
    .toSorted((a, b) => a.getTime() - b.getTime());
  return { fireTimes: times, nextRunAt: times[0] ?? null };
}

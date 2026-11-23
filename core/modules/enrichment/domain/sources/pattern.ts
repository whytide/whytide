// The email source `pattern` (README "The sources reply, website and pattern"; gamma-en-085,
// gamma-rf-030): guesses at the company's domain from its address patterns. A domain recorded
// catch-all gets none (`catch_all_domain`, F06 §9): every guess there would be "valid". With patterns
// verified or seen within PATTERN_DAYS, one guess per pattern, the most proven first, at most
// KNOWN_PATTERN_GUESSES; without one, the common patterns in their order. Never more than the
// lookup's bound still allows (`room`). The names cleaned, the first given name and the whole family
// name. A new address verified valid counts for its pattern at the settle (../lookup/settle.ts). No
// outside call; only a verifier's valid keeps one.
import { now } from "../clock.ts";
import {
  COMMON_PATTERNS,
  KNOWN_PATTERN_GUESSES,
  OUTCOMES,
  PATTERN,
  SOURCE_CLASSES,
} from "../email/constants.ts";
import { domainStatusOf } from "../email/domain-pattern.ts";
import { namesOf } from "../email/names.ts";
import { applyPattern } from "../email/patterns.ts";
import { defineSource, type EmailSourceAnswer } from "./define.ts";

export const patternSource = defineSource({
  name: PATTERN,
  kind: "email",
  activityKind: "db",
  forName: true,
  provenance: { source: SOURCE_CLASSES.pattern, provider: PATTERN },
  run: async ({ firstName, lastName, companyDomain, room }, context) => {
    if (companyDomain === "") return { found: false } satisfies EmailSourceAnswer;
    const status = await context.tenant(() => domainStatusOf(companyDomain, now()));
    if (status.catchAll) return { found: false, outcome: OUTCOMES.catchAllDomain };
    const names = namesOf(firstName, lastName);
    const known = status.patterns.slice(0, KNOWN_PATTERN_GUESSES);
    const patterns = known.length === 0 ? COMMON_PATTERNS : known;
    const guesses = patterns
      .slice(0, Math.max(0, room))
      .flatMap((pattern) => applyPattern(pattern, names) ?? [])
      .map((local) => ({ address: `${local}@${companyDomain}` }));
    if (guesses.length === 0) return { found: false, outcome: OUTCOMES.noGuess };
    return { found: true, candidates: guesses };
  },
});

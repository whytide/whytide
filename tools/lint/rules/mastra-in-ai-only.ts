import { isIn, isPackageOf } from "../paths.ts";
import type { Finding, Rule } from "../rule.ts";
import { finding, startOf } from "../rule.ts";

/**
 * Mastra's Enterprise Edition code, which is not open source: any `ee` segment under `@mastra/`,
 * `@mastra/core/auth` and every path under it (it re-exports most Enterprise exports under other
 * names), `@mastra/core/license`, and any path into a Mastra package's build (`dist/`), where the
 * Enterprise chunks live; the exports map refuses a bare `dist/` specifier, so only a path gets there.
 * The match starts the specifier or follows a `/`, so a vendored copy (`../vendor/@mastra/…`) counts.
 */
const ENTERPRISE = /(?:^|\/)@mastra\/(?:(?:[^/]+\/)*ee|core\/(?:auth|license)|[^/]+\/dist)(?:\/|$)/;

export const rule: Rule = {
  name: "mastra-in-ai-only",
  protects:
    "@mastra/* is imported only in core/packages/ai, and Mastra's Enterprise Edition code nowhere",
  check(file) {
    // @whytide/ai sets Mastra's guard (MASTRA_OFFLINE, MASTRA_TELEMETRY_DISABLED) before any Mastra
    // import; a file elsewhere, a module's agents/ included, could load Mastra before it.
    const allowed = isIn(file.path, "core/packages/ai");
    const findings: Finding[] = [];
    for (const ref of file.imports) {
      let message: string | undefined;
      if (ENTERPRISE.test(ref.specifier)) {
        message = `${ref.specifier} is refused everywhere: Mastra's Enterprise Edition code (an ee path, @mastra/core/auth, which re-exports it, @mastra/core/license, or a Mastra package's dist/, where its chunks live) is not open source`;
      } else if (
        !allowed &&
        (ref.specifier.startsWith("@mastra/") || isPackageOf(ref.specifier, "mastra"))
      ) {
        message = `Mastra is imported only in core/packages/ai (${ref.specifier}): a module's agents/ declares its tasks with @whytide/ai, which guards Mastra first`;
      }
      if (message) findings.push(finding(file, rule.name, startOf(file, ref.node), message));
    }
    return findings;
  },
};

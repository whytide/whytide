import { isIn, isPackageOf } from "../paths.ts";
import type { Finding, Rule } from "../rule.ts";
import { finding, startOf } from "../rule.ts";

export const rule: Rule = {
  name: "vendor-sdk-in-adapter-only",
  protects:
    "a vendor SDK listed in tools/lint/vendor-sdks.json is imported only inside its adapter folder",
  check(file) {
    const findings: Finding[] = [];
    for (const [folder, packages] of Object.entries(file.vendorSdks)) {
      if (isIn(file.path, folder)) continue;
      for (const ref of file.imports) {
        if (packages.some((pkg) => isPackageOf(ref.specifier, pkg))) {
          const message = `${ref.specifier} is the SDK of the adapter in ${folder}/: import it only there, and reach the vendor through its port`;
          findings.push(finding(file, rule.name, startOf(file, ref.node), message));
        }
      }
    }
    return findings;
  },
};

// A second post_engagers in a test folder (tests/kinds.test.ts): listed with sources/, the registry
// fails to load, naming both files.
import { z } from "zod";
import { defineSourceKind } from "../../../../sources/_contract.ts";

export const again = defineSourceKind(
  {
    kind: "post_engagers",
    configSchema: z.strictObject({}),
    labelKey: "signals.kinds.post_engagers.label",
    lookbackDays: 30,
    schedule: () => [],
    reader: {
      activity: "fixture_read",
      input: () => ({}),
      pageSize: 1,
      page: () => ({ candidates: [], reachedCut: true }),
    },
    event: { kind: "fixture_event", objectOf: () => "https://example.com/fixture" },
    evidenceOf: ({ objectUrl, reaction, name }) => ({ url: objectUrl, reaction, author: name }),
  },
  import.meta.url,
);

// A kind declared in a test folder (tests/kinds.test.ts): listed with sources/ by the generator, it
// joins the registry with no change to the module's files.
import { z } from "zod";
import { defineSourceKind } from "../../../../sources/_contract.ts";

export const fixtureKind = defineSourceKind(
  {
    kind: "fixture_kind",
    configSchema: z.strictObject({ topic: z.string().min(1) }),
    labelKey: "signals.kinds.fixture_kind.label",
    lookbackDays: 14,
    schedule: (_config, savedAt) => [savedAt],
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

// The fixture port of tests/pattern.test.ts, laid out as a real port is (README.md "A port"): a
// greeter with two methods and two codes. Its PROVIDER_FIXTURE lives in the tests only.
import { z } from "zod";
import { definePort } from "../../../../_pattern/index.ts";

export const fixturePort = definePort({
  name: "fixture",
  methods: {
    greet: {
      input: z.object({ name: z.string().min(1), shout: z.boolean().default(false) }),
      output: z.object({ greeting: z.string() }),
    },
    count: { input: z.void(), output: z.object({ greetings: z.int().nonnegative() }) },
  },
  errors: { fixture_rate_limited: { status: 429 }, fixture_not_found: {} },
});

// The alerts port (docs/architecture.md §9, docs/rules/coding.md §6): one short text to the team
// channel, the operators' own, in our words (README.md). One method, send(): no channel, address or
// format per call, since gamma has one team channel per instance, set in the server's .env.
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";
import { ALERT_TEXT, ALERT_TEXT_MAX } from "./constants.ts";

export { alertsConfig } from "./config.ts";
export { ALERT_TEXT_MAX } from "./constants.ts";
export type { AlertsFake } from "./fake/index.ts";

export const alertsPort = definePort({
  name: "alerts",
  errorPrefix: "alerts",
  methods: {
    send: {
      input: z.strictObject({
        text: z
          .string()
          .min(1)
          .max(ALERT_TEXT_MAX)
          .regex(ALERT_TEXT, "newlines allowed, no other control character"),
      }),
      output: z.strictObject({}),
    },
  },
  errors: {
    /** The channel refused the text for good: a 4xx answer but 429, or a redirect, never followed. */
    alerts_rejected: { status: 502 },
    /** The channel asks to wait: `details.retryAfterSec`, from its Retry-After, when it gives one. */
    alerts_rate_limited: { status: 429 },
    /** No answer, a 5xx, or no answer in time: try again later. */
    alerts_unreachable: { status: 503 },
  },
});

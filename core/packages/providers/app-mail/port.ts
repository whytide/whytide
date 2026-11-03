// The app-mail port (docs/architecture.md §9, docs/rules/coding.md §6, §8): the mail the app sends
// itself, the sign-in link first, in our words (README.md). One method, send(), to one plain address:
// the address rule leaves a mail library's address parser nothing to misread, so where a mail goes is
// decided here and nowhere else (README.md "Addresses").
import { z } from "zod";
import { definePort } from "../_pattern/index.ts";

export { appMailConfig } from "./config.ts";

const PLAIN_ADDRESS =
  /^[A-Za-z0-9_'+-]+(?:\.[A-Za-z0-9_'+-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;

/** One plain address, `ada@example.com`: no display name, comment, group, list, quotes, angle brackets or line break. */
export const plainAddress = z
  .string()
  .max(254)
  .regex(PLAIN_ADDRESS, "one plain address: no display name, comment, group, list or quotes");

export const appMailPort = definePort({
  name: "app_mail",
  errorPrefix: "mail",
  methods: {
    send: {
      input: z.strictObject({
        to: plainAddress,
        subject: z
          .string()
          .min(1)
          .regex(/^[^\r\n]*$/, "one line"),
        text: z.string().min(1),
        html: z.string().min(1).optional(),
      }),
      output: z.strictObject({ messageId: z.string().min(1) }),
    },
  },
  errors: {
    /** The server refused the mail for good (a 5xx reply): the address, the sender or the content. */
    mail_rejected: { status: 502 },
    /** Nothing reached the server, or it took nothing for now (a 4xx reply): try again later. */
    mail_unreachable: { status: 503 },
  },
});

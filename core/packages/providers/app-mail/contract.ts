// The app-mail port's contract (README.md "The contract suite"): what every adapter does, run by each
// adapter's tests/contract.test.ts with a reader of the mailbox it delivers to, the fake's memory or
// Mailpit. Every case writes to a fresh address at example.test and reads that one only, since
// Mailpit is one inbox for every worktree on the laptop.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAppError } from "@whytide/platform";
import type { ContractCases } from "../testing/index.ts";
import type { appMailPort } from "./port.ts";

/**
 * A mail as its mailbox shows it: `recipients` every address it went to (To, Cc, then Bcc, an envelope
 * recipient no header names), line breaks as `\n` with no trailing one, `html` only when sent.
 */
export type DeliveredMail = {
  readonly messageId: string;
  readonly recipients: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
};
/** The latest mail to `to` in the adapter's mailbox; it fails when none arrives. */
export type MailReader = (query: { readonly to: string }) => Promise<DeliveredMail>;

/** A body as its recipient reads it: SMTP carries CRLF and may end the body with one. */
export const asRead = (text: string): string => text.replaceAll("\r\n", "\n").replace(/\n+$/, "");

const freshAddress = () => `${randomUUID()}@example.test`;
const inputInvalid = (error: unknown) => isAppError(error) && error.code === "mail_input_invalid";

export function appMailCases(read: MailReader): ContractCases<typeof appMailPort> {
  return {
    "sends a text mail to one address; its mailbox shows it under the returned messageId": async (
      mail,
    ) => {
      const to = freshAddress();
      const subject = "Votre lien de connexion · 登录链接";
      const text = "Bonjour,\nvoici votre lien : https://whytide.test/s/abc\n\nÀ bientôt";
      const { messageId } = await mail.send({ to, subject, text });
      assert.deepEqual(await read({ to }), { messageId, recipients: [to], subject, text });
    },
    "sends the html part with the text": async (mail) => {
      const to = freshAddress();
      const sent = {
        subject: "Sign in to Whytide",
        text: "Sign in: https://whytide.test/s/abc",
        html: '<p><a href="https://whytide.test/s/abc">Sign in</a> — 登录</p>',
      };
      const { messageId } = await mail.send({ to, ...sent });
      assert.deepEqual(await read({ to }), { messageId, recipients: [to], ...sent });
    },
    "refuses anything but one plain address, a subject over two lines and a cc key: mail_input_invalid":
      async (mail) => {
        const refused = [
          "Ada <ada@example.test>", // a display name
          '"a>b"@example.test', // a quoted > (GHSA-85x2-q946-cp5h and its siblings)
          '"a;b"@example.test', // a quoted ;
          "ada@example.test; eve@example.test", // two addresses
          "ada@example.test, eve@example.test",
          "ada(team (lead))@example.test", // a nested comment
          "team: ada@example.test;", // a group
          "ada@example.test\r\nBcc: eve@example.test", // a header after a line break
        ];
        for (const to of refused) {
          const sending = mail.send({ to, subject: "Sign in", text: "t" });
          await assert.rejects(sending, inputInvalid, `to: ${JSON.stringify(to)}`);
        }
        const subject = "Sign in\r\nBcc: eve@example.test";
        await assert.rejects(mail.send({ to: freshAddress(), subject, text: "t" }), inputInvalid);
        // A key the port lacks is refused, not dropped (z.strictObject).
        const withCc = { to: freshAddress(), subject: "Sign in", text: "t", cc: freshAddress() };
        await assert.rejects(mail.send(withCc), inputInvalid, "a cc key");
      },
  };
}

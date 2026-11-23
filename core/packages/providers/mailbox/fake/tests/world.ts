// The fake's world for the mailbox contract (../../contract.ts): a consent for each case, a
// synthetic recipient, no settle time and the helpers, so that every case runs.
import { connectByConsent, type MailboxWorld } from "../../contract.ts";
import { mailboxFake } from "../index.ts";

export const fakeWorld: MailboxWorld = {
  connect: connectByConsent,
  recipient: "Lead@Example.test",
  settleSeconds: 0,
  fake: mailboxFake,
};

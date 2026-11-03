// The app-mail fake (README.md "Adapters"): every mail sent is kept in memory, in order, with the
// messageId it got; read({ to }) returns the latest one to an address as readMailpit reads it for the
// smtp adapter, so a module test reads the sign-in link here instead of in Mailpit.
import { randomUUID } from "node:crypto";
import { createFake, defineAdapter } from "../../_pattern/index.ts";
import { asRead, type DeliveredMail } from "../contract.ts";
import { appMailPort } from "../port.ts";

/** A mail as the fake keeps it: what `send` was given and the messageId it returned. */
export type SentMail = Omit<DeliveredMail, "recipients"> & { readonly to: string };

export const appMailFake = createFake(appMailPort, {
  state: () => ({ sent: [] as SentMail[] }),
  methods: (fake) => ({
    send: async ({ to, subject, text, html }) => {
      const messageId = `${randomUUID()}@fake.invalid`;
      fake.state.sent.push({
        to,
        messageId,
        subject,
        text,
        ...(html === undefined ? {} : { html }),
      });
      return { messageId };
    },
  }),
  helpers: (fake) => ({
    /** Every mail sent since the last reset, in order. */
    sent: (): readonly SentMail[] => [...fake.state.sent],
    /** The latest mail sent to `to`, in any case, as readMailpit reads one; fails when there is none. */
    read: async ({ to }: { readonly to: string }): Promise<DeliveredMail> => {
      const address = to.toLowerCase();
      const latest = fake.state.sent.findLast((mail) => mail.to.toLowerCase() === address);
      if (!latest) throw new Error("the app-mail fake sent no mail to that address");
      const { to: recipient, text, ...mail } = latest;
      return { ...mail, recipients: [recipient], text: asRead(text) };
    },
  }),
});

export const appMailFakeAdapter = defineAdapter(appMailPort, {
  name: "fake",
  create: () => appMailFake,
});

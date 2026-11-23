// A channel's AI disclosure line (README.md "The disclosure line"; gamma-p4-080), the words a text the
// campaign's mode approves ends with: for campaigns' approval-mode picker, before a switch
// (gamma-p4-070), and approvals' "Up next", on an item the mode will approve (gamma-p4-090), each
// giving it the channel, as another module's page renders a panel of this one
// (core/apps/web/docs/screens.md). Both keys are written out, so that the message check reads them.
// No client code: a server page renders it, and so can a client one.
import { useTranslations } from "next-intl";
import type { DisclosureChannel } from "../../schemas/writer.ts";

/** The channel whose line is shown: a LinkedIn message's or an email's. */
export type DisclosureLineProps = { readonly channel: DisclosureChannel };

export default function DisclosureLine({ channel }: DisclosureLineProps) {
  const t = useTranslations("messaging.disclosure");
  const lines: Record<DisclosureChannel, string> = {
    linkedin_message: t("linkedin"),
    email: t("email"),
  };
  return <p className="text-sm text-ink-muted">{lines[channel]}</p>;
}

// PROVIDER_MAILBOX (README.md "Adapters"; not in the sources: architecture §9 picks the mailbox
// adapter per sender). Set, it names the one adapter every mailbox uses, `fake` in development and
// tests; empty, each mailbox uses its own provider's adapter, `google` or `microsoft`. An unknown
// name fails getAdapter at start, `provider_unknown`; a name that is no folder name, the config.
import { defineConfig } from "@whytide/platform";
import { providerSelector } from "../_pattern/index.ts";
import type { MailboxProvider } from "./constants.ts";

export const mailboxConfig = defineConfig("packages/providers", {
  PROVIDER_MAILBOX: providerSelector(),
});

/** The adapter a mailbox of the provider uses, for getAdapter: PROVIDER_MAILBOX when set, else the provider's own. */
export const mailboxAdapterFor = (
  provider: MailboxProvider,
  config: { readonly PROVIDER_MAILBOX?: string | undefined } = mailboxConfig,
): string => config.PROVIDER_MAILBOX ?? provider;

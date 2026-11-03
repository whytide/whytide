// The module's webhook, which the api host mounts at POST /v1/linkedin/webhooks/:provider (core/apps/
// api/README.md "Modules"): outside the workspaces, no session, rate-limited per address, the body
// read raw within `bodyLimit` and handed to the adapter's parseWebhook, which checks its signature.
// No tenant run until the account is found (domain/status.ts).
import type { LinkedinWebhook } from "@whytide/providers";
import { handleWebhook } from "../domain/status.ts";

export const webhooks = {
  /** Vendors' webhooks are small JSON, a message's text included; parseWebhook has no limit. */
  bodyLimit: 64 * 1024,
  receive: (input: { readonly provider: string } & LinkedinWebhook): Promise<void> =>
    handleWebhook(input.provider, { headers: input.headers, rawBody: input.rawBody }),
};

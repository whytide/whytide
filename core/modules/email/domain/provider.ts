// The mailbox port as this module uses it (docs/security.md): the adapter of a mailbox's provider, or
// PROVIDER_MAILBOX's when set (`fake` in development and tests), and the tokens as the api seals them,
// one JSON under TOKENS_PURPOSE for the workspace's organization. Only workflows/decrypt.ts opens them.
import { encryptSecret, type SecretKeys } from "@whytide/platform";
import {
  getAdapter,
  type MailboxProvider,
  mailboxAdapterFor,
  mailboxPort,
} from "@whytide/providers";
import { TOKENS_PURPOSE } from "./constants.ts";

/** What the blob holds, in clear only inside workflows/decrypt.ts. */
export type MailboxTokens = {
  readonly refreshToken: string;
  readonly accessToken: string;
  /** ISO 8601: when the access token stops working. */
  readonly expiresAt: string;
};

/**
 * What withMailboxTokens (workflows/decrypt.ts) answers: `fn`'s value, or why it did not run: the
 * mailbox holds no tokens, the provider answered mailbox_token_revoked, now the mailbox's state, or
 * the mailbox is no longer as the caller's narrowing of the read says (changed).
 */
export type TokensAnswer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: "no_tokens" | "token_revoked" | "changed" };

let keys: SecretKeys | undefined;

/** For tests (testing/): the keys to seal, derive and open with instead of APP_MASTER_KEY's. */
export function useSecretKeys(next: SecretKeys | undefined): void {
  keys = next;
}

/** The given keys, or undefined for the host's own (the helpers' default). */
export const secretKeys = (): SecretKeys | undefined => keys;

/** The bound adapter of the provider, loaded at the first call and kept for the process. */
export const mailboxAdapter = (provider: MailboxProvider) =>
  getAdapter(mailboxPort, mailboxAdapterFor(provider));

/** The tokens sealed for the organization: the blob of oauth_token_ref. */
export function sealTokens(tokens: MailboxTokens, organizationId: string) {
  const { refreshToken, accessToken, expiresAt } = tokens;
  const plain = JSON.stringify({ refreshToken, accessToken, expiresAt });
  const context = { organizationId, purpose: TOKENS_PURPOSE };
  return new Uint8Array(encryptSecret(plain, context, secretKeys()));
}

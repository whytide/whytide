// The LinkedIn port as this module uses it (docs/security.md): the adapter PROVIDER_LINKEDIN names,
// the purpose its account reference is sealed for, and that reference's hash, which the webhook finds
// an account by. The reference itself is encrypted with the platform's envelope helper; only the
// worker decrypts it (workflows/decrypt.ts).
import { createHash } from "node:crypto";
import type { SecretKeys } from "@whytide/platform";
import { getAdapter, linkedinConfig, linkedinPort } from "@whytide/providers";

/** The context's purpose: a reference sealed for it opens for it only (core/packages/platform "Secrets at rest"). */
export const REF_PURPOSE = "linkedin_account";

let keys: SecretKeys | undefined;

/** For tests (testing/): the keys to seal and open with instead of APP_MASTER_KEY's. */
export function useSecretKeys(next: SecretKeys | undefined): void {
  keys = next;
}

/** The given keys, or undefined for the host's own (the helpers' default). */
export const secretKeys = (): SecretKeys | undefined => keys;

/** The adapter's name, `fake` or `unipile`, stored on the account and checked against the webhook's path. */
export function providerName(): string {
  const name = linkedinConfig.PROVIDER_LINKEDIN;
  if (name === undefined) throw new Error("PROVIDER_LINKEDIN is not set (deploy/.env.example)");
  return name;
}

/** The bound adapter, loaded at the first call and kept for the process. */
export const linkedin = () => getAdapter(linkedinPort, providerName());

/** SHA-256 of `<provider>:<reference>`, hex: the lookup key across workspaces, never the reference. */
export function refHash(provider: string, providerAccountRef: string): string {
  return createHash("sha256").update(`${provider}:${providerAccountRef}`).digest("hex");
}

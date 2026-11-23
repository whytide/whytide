// PKCE (RFC 7636), the S256 method createAuthUrl takes: the caller keeps a new verifier with its
// pending connection and sends its challenge; exchangeCode then proves the code is its own.
import { createHash, randomBytes } from "node:crypto";
import { CODE_VERIFIER_BYTES } from "./constants.ts";

/** A new code verifier: 32 random bytes in base64url, 43 characters. */
export const newCodeVerifier = (): string => randomBytes(CODE_VERIFIER_BYTES).toString("base64url");

/** The verifier's S256 challenge: its SHA-256 in base64url. */
export const codeChallengeFor = (codeVerifier: string): string =>
  createHash("sha256").update(codeVerifier).digest("base64url");

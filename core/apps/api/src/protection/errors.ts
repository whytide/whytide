// The request protections' codes (docs/security.md), developer-facing like the host's: no message
// keys. A body over its limit is NestJS's 413, which the error filter answers as payload_too_large.
import { defineErrors } from "@whytide/platform";

export const protectionErrors = defineErrors({
  /** Over the workspace's or the address's limit; `Retry-After` says when to try again. */
  rate_limited: { status: 429 },
  /** A state-changing request with a session cookie from neither the app's origin nor the api's. */
  origin_rejected: { status: 403 },
  /** An @Idempotent() route called without an Idempotency-Key header. */
  idempotency_key_required: { status: 400 },
});

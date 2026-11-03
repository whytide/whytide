// The security headers (docs/security.md), set on every response before anything else answers, so
// errors and the not-found answer carry them too: nosniff, no referrer, no camera, microphone or
// geolocation, and HSTS in production; on /v1/ also no caching and a content security policy that
// allows nothing, since the api answers JSON and is never framed. Node and Express send no Server
// header and the host turns X-Powered-By off.
import type { IncomingMessage, ServerResponse } from "node:http";

type Header = readonly [name: string, value: string];

const EVERY: readonly Header[] = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "no-referrer"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=()"],
];
const PRODUCTION: readonly Header[] = [
  ["strict-transport-security", "max-age=31536000; includeSubDomains"],
];
const API: readonly Header[] = [
  ["cache-control", "no-store"],
  ["content-security-policy", "default-src 'none'; frame-ancestors 'none'"],
];
/** /v1 and below, in any case: Express routes paths without regard to case. */
const API_PATH = /^\/v1(?:[/?#]|$)/i;

export function securityHeaders(production: boolean) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const headers = [
      ...EVERY,
      ...(production ? PRODUCTION : []),
      ...(API_PATH.test(req.url ?? "") ? API : []),
    ];
    for (const [name, value] of headers) res.setHeader(name, value);
    next();
  };
}

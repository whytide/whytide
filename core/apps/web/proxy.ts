// The pages' content security policy (docs/rules/security.md §5): scripts only from the app's origin
// that Next.js marks with this request's nonce, styles from the origin or with the nonce, nothing
// framed, no plugin, forms and the base URL to the origin only. One fresh nonce a request; the api's
// own answers carry their own policy (core/apps/api/docs/security.md). The page asked for travels to
// the workspace layout as x-whytide-path, where a visitor with no session is sent to sign in. The
// sign-in confirm page (the auth port's AUTH_LINK_CONFIRM_PATH) has a link's token in its URL: no
// request from it sends that on as a Referer.
import { type NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  // React rebuilds server stack traces with eval in development only.
  const evalInDev = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${evalInDev}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  headers.set("x-whytide-path", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set("content-security-policy", policy);
  if (request.nextUrl.pathname === "/sign-in/confirm") {
    response.headers.set("referrer-policy", "no-referrer");
  }
  return response;
}

export const config = {
  // Not the api's paths, Next.js's static files, nor a prefetch, whose answer no page renders.
  matcher: [
    {
      source: "/((?!api/|_next/static|_next/image).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};

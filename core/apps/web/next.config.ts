// Next.js for the web host (README "Run"): standalone output for the image; the api behind /api,
// rewritten here when NEXT_PUBLIC_API_URL is set (scripts/next.ts sets it) and routed by Caddy in
// production; nothing fetched from outside the laptop: no image optimizer (sharp is not installed),
// no upgrade check against the npm registry, no AGENTS.md written by `next dev`.
import { resolve } from "node:path";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// `next` runs in core/apps/web; the repository root holds the lockfile and the workspace packages.
const root = resolve(process.cwd(), "../../..");
// A module's screens take the API client from here (docs/screens.md "The API"), resolved for them: a
// module does not list @whytide/web, which would close the cycle api -> module -> web -> api that
// pnpm refuses in every `pnpm -r`. tsconfig.json's `paths` says the same to the type checker.
const screenApi = {
  "@whytide/web/api/browser": "./src/api/browser.ts",
  "@whytide/web/api/server": "./src/api/server.ts",
};
const api = process.env.NEXT_PUBLIC_API_URL;

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: root,
  turbopack: { root, resolveAlias: screenApi },
  poweredByHeader: false,
  images: { unoptimized: true },
  agentRules: false,
  experimental: { agentUpgrade: false },
  async rewrites() {
    if (!api) return [];
    return [
      { source: "/api/auth/:path*", destination: `${api}/api/auth/:path*` },
      // The LinkedIn fake's hosted links, on this origin, served by the e2e api (APP_ENV=test only).
      { source: "/api/linkedin/:path*", destination: `${api}/api/linkedin/:path*` },
      { source: "/api/v1/:path*", destination: `${api}/v1/:path*` },
    ];
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(config);

// The end-to-end tests (docs/screens.md "Playwright"): the host's tests/*.spec.ts and each module's,
// headless Chromium, against the worktree's e2e api and web, which this starts unless they already
// listen on API_PORT and WEB_PORT (.env.local): `pnpm -F api serve:e2e`, the api under APP_ENV=test
// with the fixture module, and `pnpm -F web serve:e2e`, next build with the test modules, then next start.
// `--project=all` runs Chromium, Firefox and WebKit, for the full pipeline.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const envFile = join(import.meta.dirname, "..", "..", "..", ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const { API_PORT, WEB_PORT } = process.env;
// The workers load this file too, with other arguments: the choice travels in the environment.
if (process.argv.includes("--project=all")) process.env.WEB_E2E_ALL_BROWSERS = "1";
const browsers = process.env.WEB_E2E_ALL_BROWSERS
  ? { chromium: "Desktop Chrome", firefox: "Desktop Firefox", webkit: "Desktop Safari" }
  : { chromium: "Desktop Chrome" };
const server = { reuseExistingServer: true, timeout: 300_000, stdout: "pipe" } as const;

export default defineConfig({
  testDir: "../..",
  testMatch: ["apps/web/tests/*.spec.ts", "modules/*/tests/*.spec.ts"],
  forbidOnly: true,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    ...Object.entries(browsers).map(([name, device]) => ({ name, use: { ...devices[device] } })),
    ...(process.env.WEB_E2E_ALL_BROWSERS
      ? [{ name: "all", testMatch: [], dependencies: Object.keys(browsers) }]
      : []),
  ],
  webServer: [
    { ...server, name: "api", command: "pnpm -F api serve:e2e", port: Number(API_PORT) },
    { ...server, name: "web", command: "pnpm serve:e2e", port: Number(WEB_PORT) },
  ],
});

// The end-to-end tests of tests/*.spec.ts, in Playwright's own Chromium, headless: each test loads the
// gallery itself (tests/gallery-page.ts), so no web server starts.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  testMatch: "*.spec.ts",
  forbidOnly: true,
  reporter: "list",
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

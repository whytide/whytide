// The fixtures of the host's end-to-end tests (docs/screens.md "Playwright"). signInAs(email) opens a
// session on the e2e api through the fake adapter's test route, POST /api/auth/fake/sign-in, sent
// through the web's /api rewrite so that the cookie lands on the web's host. The e2e api makes its
// E2E_USERS Owners of its two workspaces (core/apps/api/tests/e2e-server.ts): E2E_EMAIL unless the
// spec names another.
import { test as base, expect } from "@playwright/test";

export const E2E_EMAIL = "e2e@example.com";

export const test = base.extend<{ signInAs: (email?: string) => Promise<void> }>({
  signInAs: async ({ context, baseURL }, use) => {
    await use(async (email = E2E_EMAIL) => {
      const answer = await context.request.post("/api/auth/fake/sign-in", {
        data: { email },
        headers: { origin: baseURL ?? "" },
      });
      const hint = "the api on API_PORT must be `pnpm -F api serve:e2e` (APP_ENV=test), not `dev`";
      expect(answer.status(), hint).toBe(204);
    });
  },
});

export { expect };

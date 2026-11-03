// tenancy's feedback link in the shell's header (alpha-p10-040; core/modules/tenancy/README.md
// "Settings"): the e2e api sets FEEDBACK_URL (core/apps/api/tests/e2e-server.ts), so every workspace
// page links to it, and the link opens a new tab with no opener. The page it opens is answered here,
// so nothing leaves the laptop. Unset, GET /v1/me answers feedbackUrl null (core/apps/api/tests/
// me.test.ts) and the header renders no link (src/shell/feedback-link.tsx).
import tenancy from "../../../modules/tenancy/messages/en.json" with { type: "json" };
import { expect, test } from "./sign-in.ts";

const WORKSPACE = "wsp_fixture_a"; // the one workspace the api's fixture module knows
const FEEDBACK_URL = "https://feedback.example.com/alpha"; // as e2e-server.ts sets it

test("every workspace page's header links to FEEDBACK_URL, which opens in a new tab", async ({
  page,
  context,
  signInAs,
}) => {
  await context.route(
    (url) => url.hostname === "feedback.example.com",
    (route) => route.fulfill({ contentType: "text/html", body: "<title>Feedback</title>" }),
  );
  await signInAs();
  const name = tenancy["tenancy.feedback.link"];
  const link = page.getByRole("banner").getByRole("link", { name });
  for (const screen of ["ada", "missing"]) {
    await page.goto(`/w/${WORKSPACE}/fixture?name=${screen}`); // a screen, then one that throws
    await expect(link).toHaveAttribute("href", FEEDBACK_URL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  const [tab] = await Promise.all([context.waitForEvent("page"), link.click()]);
  await expect(tab).toHaveURL(FEEDBACK_URL);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  await expect(page).toHaveURL(/\/fixture\?name=missing$/); // the workspace page stays
});

// The Unipile adapter's one contractSuite call (../../../README.md "The contract suite"): the port's
// cases against the Unipile sandbox, skipped while UNIPILE_BASE_URL, UNIPILE_API_KEY or
// UNIPILE_WEBHOOK_SECRET is empty in the environment (README.md "Sandbox"; .env.local is not read).
// The account is the one connected by hand in the sandbox, the post and the profile are named by
// UNIPILE_TEST_POST_URL and UNIPILE_TEST_PROFILE_URL, and the webhooks are written as Unipile sends
// them to a registered endpoint, with the secret header. The sandbox cannot be made to rate-limit:
// the 429 mapping is mapping.test.ts's.
import assert from "node:assert/strict";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { type LinkedinWorld, linkedinCases } from "../../contract.ts";
import { type LinkedinWebhook, linkedinPort } from "../../port.ts";
import { SECRET_HEADER, unipileAdapter } from "../index.ts";

const env = process.env;
const MESSAGES = {
  "account.connected": "CREATION_SUCCESS",
  "account.disconnected": "DELETED",
  "account.credentials_required": "CREDENTIALS",
} as const;
let account: string | undefined;

/** The LinkedIn account connected by hand in the sandbox: the first whose sources all run. */
async function sandboxAccount(): Promise<string> {
  if (account) return account;
  const response = await fetch(new URL("/api/v1/accounts", env.UNIPILE_BASE_URL), {
    headers: { accept: "application/json", "x-api-key": env.UNIPILE_API_KEY ?? "" },
  });
  assert.equal(response.status, 200, "GET /api/v1/accounts");
  const { items } = (await response.json()) as {
    items: { id: string; type: string; sources: { status: string }[] }[];
  };
  const found = items.find(
    ({ type, sources }) => type === "LINKEDIN" && sources.every(({ status }) => status === "OK"),
  );
  assert.ok(found, 'a LinkedIn account connected by hand in the sandbox (README.md "Sandbox")');
  account = found.id;
  return account;
}

function variable(name: string): string {
  const value = env[name];
  assert.ok(value, `${name} (README.md "Sandbox")`);
  return value;
}

const signed = (body: unknown, secret = env.UNIPILE_WEBHOOK_SECRET ?? ""): LinkedinWebhook => ({
  headers: { "content-type": "application/json", [SECRET_HEADER]: secret },
  rawBody: JSON.stringify(body),
});

const world: LinkedinWorld = {
  // The hosted-auth notify of an account connected through the link, with the secret header.
  connect: async (link) =>
    signed({
      status: "CREATION_SUCCESS",
      account_id: await sandboxAccount(),
      name: link.providerRef,
    }),
  post: async () => {
    const postUrl = variable("UNIPILE_TEST_POST_URL");
    const linkedin = bindPort(linkedinPort, unipileAdapter.create(), { adapter: "unipile" });
    const providerAccountRef = await sandboxAccount();
    let [engagers, cursor] = [0, undefined as string | null | undefined];
    while (cursor !== null) {
      const page = await linkedin.listPostEngagers({
        providerAccountRef,
        postUrl,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      [engagers, cursor] = [engagers + page.engagers.length, page.nextCursor];
    }
    return { postUrl, engagers };
  },
  profile: async () => ({ profileUrl: variable("UNIPILE_TEST_PROFILE_URL") }),
  webhook: async ({ kind, providerAccountRef }, { forged = false } = {}) => {
    const body = {
      account_id: providerAccountRef,
      account_type: "LINKEDIN",
      message: MESSAGES[kind],
    };
    const secret = forged ? `${env.UNIPILE_WEBHOOK_SECRET}-forged` : undefined;
    return signed({ AccountStatus: body }, secret);
  },
};

contractSuite(linkedinPort, unipileAdapter, linkedinCases(world));

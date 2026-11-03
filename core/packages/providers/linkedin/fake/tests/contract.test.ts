// The fake's contract suite (README.md "The contract suite"). Its world seeds a post of ninety
// engagers and a profile, connects through connectOnVisit() mounted on a node:http server of the
// test's own (fetch, to 127.0.0.1 only) and signs webhooks with emitWebhook. Then the fake's own:
// failNext's retryAfterSec and recordedCalls, and the route under APP_ENV=test only.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { promisify } from "node:util";
import { isAppError } from "@whytide/platform";
import { bindPort } from "../../../_pattern/index.ts";
import { contractSuite } from "../../../testing/index.ts";
import { type LinkedinWorld, linkedinCases, RETURN_URLS } from "../../contract.ts";
import { type Engager, type LinkedinWebhook, linkedinPort } from "../../port.ts";
import { linkedinFake, linkedinFakeAdapter, SIGNATURE_HEADER } from "../index.ts";

const POST = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";
const ADA = {
  providerMemberRef: "fake-member-ada",
  profileUrl: "https://www.linkedin.com/in/ada-example",
  firstName: "Ada",
  lastName: "Example",
  headline: "Head of Growth at Example",
  title: "Head of Growth",
  companyName: "Example Ltd",
  companyUrl: "https://www.linkedin.com/company/example",
  locationText: "London, United Kingdom",
  industry: "Software Development",
};
const engager = (i: number): Engager => ({
  providerMemberRef: `fake-member-${i}`,
  profileUrl: `https://www.linkedin.com/in/member-${i}`,
  name: `Member ${i}`,
  headline: "Founder at Example",
  reaction: i % 3 === 0 ? "comment" : "like",
  ...(i % 3 === 0 ? { commentText: "Useful, thanks" } : {}),
  engagedAt: new Date(Date.UTC(2026, 9, 1, 8, i)),
});

const world: LinkedinWorld = {
  connect: async (link, t) => {
    const delivered: LinkedinWebhook[] = [];
    const handler = linkedinFake.connectOnVisit(async (webhook) => delivered.push(webhook));
    const server = createServer((req, res) => handler(req, res, () => res.writeHead(404).end()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const { port } = server.address() as AddressInfo;
    const { pathname, search } = new URL(link.url);
    const visit = () =>
      fetch(`http://127.0.0.1:${port}${pathname}${search}`, { redirect: "manual" });
    const response = await visit();
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), RETURN_URLS.successUrl);
    assert.equal((await visit()).status, 404, "a link works once");
    assert.equal(delivered.length, 1);
    return delivered[0] as LinkedinWebhook;
  },
  post: async () => {
    linkedinFake.seedPost(
      POST,
      Array.from({ length: 90 }, (_, i) => engager(i)),
    );
    return { postUrl: POST, engagers: 90 };
  },
  profile: async () => {
    linkedinFake.seedProfile(ADA);
    return { profileUrl: ADA.profileUrl, expected: ADA };
  },
  webhook: async ({ kind, providerAccountRef }, { forged = false } = {}) => {
    const webhook = linkedinFake.emitWebhook(kind, providerAccountRef);
    const wrong = { [SIGNATURE_HEADER]: `sha256=${"0".repeat(64)}` };
    return forged ? { ...webhook, headers: { ...webhook.headers, ...wrong } } : webhook;
  },
  rateLimitNext: () => linkedinFake.failNext("linkedin_rate_limited"),
};

contractSuite(linkedinPort, linkedinFakeAdapter, linkedinCases(world));

test("failNext('linkedin_rate_limited') carries retryAfterSec; recordedCalls holds every call with its input", async () => {
  const linkedin = bindPort(linkedinPort, linkedinFakeAdapter.create(), { adapter: "fake" });
  linkedinFake.reset();
  const ref = "fake-account-ada";
  const webhook = linkedinFake.emitWebhook("account.connected", ref);
  linkedinFake.seedPost(POST, [engager(1)]);
  linkedinFake.seedProfile(ADA);
  const retryAfter = (error: unknown) => isAppError(error) && error.details?.retryAfterSec;
  linkedinFake.failNext("linkedin_rate_limited");
  await assert.rejects(linkedin.getAccountStatus(ref), (error) => retryAfter(error) === 60);
  linkedinFake.failNext("linkedin_rate_limited", { retryAfterSec: 5 });
  await assert.rejects(linkedin.getAccountStatus(ref), (error) => retryAfter(error) === 5);
  const link = { successUrl: RETURN_URLS.successUrl, failureUrl: RETURN_URLS.failureUrl };
  await linkedin.createHostedAuthLink({ ...link, expiresInMin: 5 });
  await linkedin.listPostEngagers({ providerAccountRef: ref, postUrl: POST, limit: 10 });
  await linkedin.getProfile({ providerAccountRef: ref, profileUrl: ADA.profileUrl });
  await linkedin.parseWebhook(webhook);
  assert.deepEqual(linkedinFake.recordedCalls, [
    { method: "getAccountStatus", input: ref },
    { method: "getAccountStatus", input: ref },
    { method: "createHostedAuthLink", input: { ...link, expiresInMin: 5 } },
    { method: "listPostEngagers", input: { providerAccountRef: ref, postUrl: POST, limit: 10 } },
    { method: "getProfile", input: { providerAccountRef: ref, profileUrl: ADA.profileUrl } },
    { method: "parseWebhook", input: webhook },
  ]);
});

test("the connect route is served under APP_ENV=test only", async () => {
  const fake = JSON.stringify(import.meta.resolve("../index.ts"));
  const script = [
    `const { linkedinFake } = await import(${fake});`,
    "const handler = linkedinFake.connectOnVisit();",
    "const { url } = await linkedinFake.createHostedAuthLink({",
    '  successUrl: "https://app.whytide.test/ok", failureUrl: "https://app.whytide.test/ko", expiresInMin: 5 });',
    "let answer = 404;",
    "const res = { headersSent: false, writeHead: (status) => ((answer = status), { end() {} }) };",
    'handler({ method: "GET", url: new URL(url).pathname + new URL(url).search }, res, () => {});',
    "await new Promise((resolve) => setTimeout(resolve, 50));",
    "console.log(answer);",
  ].join("\n");
  const run = (APP_ENV: string) =>
    promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, APP_ENV },
    }).then(({ stdout }) => `${APP_ENV} ${stdout.trim()}`);
  assert.deepEqual(await Promise.all(["test", "development", "production"].map(run)), [
    "test 303",
    "development 404",
    "production 404",
  ]);
});

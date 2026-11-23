// `pnpm invite`'s mail (gamma-p6-020; README.md "The invite command"), run as its bin runs it, on
// this file's schema, with the app-mail fake (PROVIDER_APP_MAIL=fake, the test script's): the invite
// mail and mail_sent; mail_skipped with --no-mail or while APP_PUBLIC_ORIGIN is empty; mail_failed
// with exit 3, the invite made, and inviting again once it expired sends again; an open invite or a
// member answered with exit 0 and no mail.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { appMailPort, getAdapter } from "@whytide/providers";
import { bootstrapOrganization, settings } from "@whytide/tenancy";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { runInvite } from "../cli/invite.ts";
import { INVITE_TTL_MS } from "../domain/rules.ts";
import { useIdentityClient, useIdentityClock } from "../testing/index.ts";

withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
afterEach(() => useIdentityClock(undefined));

const ORIGIN = "https://app.example.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;
const T0 = new Date("2026-11-12T09:00:00.000Z");

/** The fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = {
  read(query: { to: string }): Promise<{ subject: string; text: string }>;
  sent(): readonly { to: string }[];
  failNext(code: string): void;
};
const appMailFake = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const mailsTo = (to: string) => appMailFake.sent().filter((mail) => mail.to === to).length;
const rowOf = (email: string) => app.invite.findFirstOrThrow({ where: { email } });

/** The command's exit code, its lines and each line's code. */
async function invite(...args: string[]) {
  const lines: string[] = [];
  const code = await runInvite(args, (line) => lines.push(line));
  return { code, lines, codes: lines.map((line) => line.split(":")[0]) };
}

test("pnpm invite mails the invite: the workspace, the role, the expiry, the address and the Invitations page, no token or sign-in link; mailed_at set", async () => {
  const owner = await createUser();
  const workspaceSlug = settings.WORKSPACE_SLUG;
  await bootstrapOrganization({ name: "Acme Sales", workspaceSlug, ownerUserId: owner.id });
  useIdentityClock(() => T0);

  const first = await invite("Ann@Example.test");
  assert.deepEqual([first.code, first.codes], [0, ["invite_created", "mail_sent"]]);
  assert.equal(first.lines[1], "mail_sent: ann@example.test");
  const mail = await appMailFake.read({ to: "ann@example.test" });
  assert.equal(mail.subject, "You are invited to Acme Sales on Whytide");
  assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [`${ORIGIN}/invitations`]);
  for (const part of ["Acme Sales", "as an Owner", "ann@example.test", "November 19, 2026"]) {
    assert.ok(mail.text.includes(part), part);
  }
  assert.doesNotMatch(mail.text, /token|\/api\/auth|sign-in/i);
  assert.deepEqual((await rowOf("ann@example.test")).mailedAt, T0);

  // An open invite and a member are answered, exit 0, and mailed nothing.
  const again = await invite("ann@example.test");
  assert.deepEqual([again.code, again.codes], [0, ["invite_exists"]]);
  const member = await invite(owner.email);
  assert.deepEqual([member.code, member.codes], [0, ["already_member"]]);
  assert.deepEqual([mailsTo("ann@example.test"), mailsTo(owner.email)], [1, 0]);
});

test("--no-mail and an empty APP_PUBLIC_ORIGIN skip the mail; a failed one keeps the invite with exit 3, and inviting again once it expired sends again", async () => {
  const [a] = await createTwoWorkspaces();
  const to = (email: string, ...more: string[]) =>
    invite(email, "--workspace", a.workspace.id, ...more);
  useIdentityClock(() => T0);
  const skipped = await to("bo@example.test", "--no-mail");
  assert.deepEqual([skipped.code, skipped.lines.slice(1)], [0, ["mail_skipped: --no-mail"]]);
  process.env.APP_PUBLIC_ORIGIN = "";
  try {
    const bare = await to("cy@example.test");
    const line = "mail_skipped: APP_PUBLIC_ORIGIN is empty, and a path alone is no use in a mail";
    assert.deepEqual([bare.code, bare.lines.slice(1)], [0, [line]]);
  } finally {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  }
  assert.deepEqual([mailsTo("bo@example.test"), mailsTo("cy@example.test")], [0, 0]);
  assert.equal((await rowOf("cy@example.test")).mailedAt, null);

  appMailFake.failNext("mail_unreachable");
  const failed = await to("di@example.test");
  const why = "mail_failed: mail_unreachable: no mail went to di@example.test; the invite is made";
  assert.deepEqual([failed.code, failed.lines.slice(1)], [3, [why]]);
  const kept = await rowOf("di@example.test");
  assert.deepEqual([kept.acceptedAt, kept.revokedAt, kept.mailedAt], [null, null, null]);

  const expired = new Date(T0.getTime() + INVITE_TTL_MS);
  useIdentityClock(() => expired);
  const renewed = await to("di@example.test");
  assert.deepEqual([renewed.code, renewed.codes], [0, ["invite_created", "mail_sent"]]);
  assert.equal(mailsTo("di@example.test"), 1);
  assert.deepEqual((await rowOf("di@example.test")).mailedAt, expired);
  assert.equal(await app.invite.count({ where: { email: "di@example.test" } }), 1);

  assert.equal((await invite("--no-mail")).code, 2);
});

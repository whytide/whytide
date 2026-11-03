// `pnpm tenant:create` and `pnpm workspace:create` (README.md "The tenant commands"), run as their
// bins run them, on this file's schema, with the app-mail fake (PROVIDER_APP_MAIL=fake, the test
// script's): the rows, the mail to the admin, the refusals and the exit codes.
import assert from "node:assert/strict";
import test from "node:test";
import { asRole, withTestDb } from "@whytide/db/testing";
import { appMailPort, getAdapter } from "@whytide/providers";
import { disableUser, listMemberships, upsertUser } from "@whytide/tenancy";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { runTenantCreate } from "../cli/tenant-create.ts";
import { runWorkspaceCreate } from "../cli/workspace-create.ts";
import { allowSignIn } from "../domain/sign-in.ts";
import { useIdentityClient } from "../testing/index.ts";

withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));

const ORIGIN = "https://app.example.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;

/** The fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = {
  read(query: { to: string }): Promise<{ subject: string; text: string }>;
  sent(): readonly { to: string }[];
  failNext(code: string): void;
};
const appMailFake = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;

/** The command's exit code, its lines and each line's code; an argument string splits at spaces. */
async function run(command: typeof runTenantCreate, args: string | string[]) {
  const lines: string[] = [];
  const code = await command(typeof args === "string" ? args.split(" ") : args, (line) => {
    lines.push(line);
  });
  return { code, lines, codes: lines.map((line) => line.split(":")[0]) };
}
const tenant = (args: string | string[]) => run(runTenantCreate, args);
const workspace = (args: string | string[]) => run(runWorkspaceCreate, args);
const userOf = (email: string) => asRole("app").user.findUniqueOrThrow({ where: { email } });
const mailsTo = (to: string) => appMailFake.sent().filter((mail) => mail.to === to).length;
async function counts() {
  const [row] = await asRole("app").$queryRaw<Record<string, number>[]>`
    SELECT (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM organizations)::int AS organizations,
      (SELECT count(*) FROM workspaces)::int AS workspaces,
      (SELECT count(*) FROM memberships)::int AS memberships`;
  return row;
}

/** The mail to the admin: its one link is the sign-in page; the address and the names; no token. */
async function mailed(to: string, names: string[]) {
  const mail = await appMailFake.read({ to });
  assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [`${ORIGIN}/sign-in`]);
  for (const name of [to, ...names]) assert.ok(mail.text.includes(name), name);
  assert.doesNotMatch(mail.text, /token/i);
  return mail;
}

test("pnpm tenant:create makes the organization, its workspace and the Owner, and mails the admin the sign-in page; the admin may sign in", async () => {
  const args = "--slug acme-test --admin-email Ada@Example.test".split(" ");
  const made = await tenant(["--name", "Acme Test", "--admin-name", "Ada Admin", ...args]);
  assert.equal(made.code, 0);
  assert.match(
    made.lines[0] ?? "",
    /^organization_created: Acme Test, workspace acme-test \(wsp_\w+\), Owner ada@example\.test$/,
  );
  const sent = ["mail_sent: ada@example.test", `sign_in_page: ${ORIGIN}/sign-in`];
  assert.deepEqual(made.lines.slice(1), sent);
  const ada = await userOf("ada@example.test");
  assert.equal(ada.displayName, "Ada Admin");
  const listed = (await listMemberships(ada.id)).map((m) => [m.slug, m.organizationName, m.role]);
  assert.deepEqual(listed, [["acme-test", "Acme Test", "Owner"]]);
  assert.match((await mailed("ada@example.test", ["Acme Test"])).subject, /Acme Test/);
  assert.equal(await allowSignIn("ada@example.test"), true);
});

test("a second pnpm tenant:create with the slug exits 1 and makes no user; --no-mail sends nothing; a disabled user is refused before anything is made", async () => {
  const first = await tenant("--name Acme --slug acme --admin-email bob@example.test --no-mail");
  const made = ["organization_created", "mail_skipped", "sign_in_page"];
  assert.deepEqual([first.code, first.codes], [0, made]);
  assert.equal(mailsTo("bob@example.test"), 0);
  const dan = await upsertUser({ email: "dan@example.test" });
  await disableUser(dan.id);
  const before = await counts();

  const again = await tenant("--name Other --slug acme --admin-email carol@example.test");
  assert.deepEqual([again.code, again.lines], [1, ["organization_exists: acme"]]);
  const disabled = await tenant("--name Dan --slug dan-co --admin-email dan@example.test");
  assert.deepEqual([disabled.code, disabled.codes], [1, ["user_disabled"]]);
  const refused = await workspace(
    "--org acme --name Dan --slug dan --admin-email dan@example.test",
  );
  assert.deepEqual([refused.code, refused.codes], [1, ["user_disabled"]]);
  assert.deepEqual(await counts(), before);
  assert.equal(mailsTo("carol@example.test") + mailsTo("dan@example.test"), 0);
});

test("pnpm workspace:create by slug and by id; an existing user gets a second membership; an unknown organization and a taken slug exit 1", async () => {
  await tenant("--name Acme --slug acme --admin-email hal@example.test --no-mail");
  const bySlug = await workspace(
    "--org acme --name Sales --slug sales --admin-email hal@example.test",
  );
  assert.equal(bySlug.code, 0);
  assert.match(
    bySlug.lines[0] ?? "",
    /^workspace_created: Acme, workspace sales \(wsp_\w+\), Owner hal@example\.test$/,
  );
  assert.deepEqual(bySlug.codes.slice(1), ["mail_sent", "sign_in_page"]);
  assert.match((await mailed("hal@example.test", ["Sales", "Acme"])).subject, /Sales/);
  const hal = await userOf("hal@example.test");
  const owned = (await listMemberships(hal.id)).map(({ slug, role }) => `${slug} ${role}`);
  assert.deepEqual(owned, ["acme Owner", "sales Owner"]);

  const org = await asRole("app").organization.findUniqueOrThrow({ where: { slug: "acme" } });
  const support = "--name Support --slug support --admin-email eve@example.test --no-mail";
  assert.equal((await workspace(`--org ${org.id} ${support}`)).code, 0);
  const eve = await listMemberships((await userOf("eve@example.test")).id);
  assert.deepEqual(
    eve.map((m) => [m.slug, m.organizationId]),
    [["support", org.id]],
  );
  assert.equal(await allowSignIn("eve@example.test"), true);

  const before = await counts();
  const rest = "--name X --slug x-ray --admin-email hal@example.test".split(" ");
  for (const named of ["nowhere", "org_missing", "Not a slug"]) {
    const unknown = await workspace(["--org", named, ...rest]);
    assert.deepEqual([unknown.code, unknown.lines], [1, [`organization_not_found: ${named}`]]);
  }
  const taken = await workspace(
    "--org acme --name Again --slug sales --admin-email hal@example.test",
  );
  assert.deepEqual([taken.code, taken.lines], [1, ["workspace_exists: sales"]]);
  assert.deepEqual(await counts(), before);
});

test("a bad email or a missing option exits 2; a failed mail exits 3 once the rows are made; with APP_PUBLIC_ORIGIN empty no mail goes", async () => {
  const fay = "--admin-email fay@example.test";
  const usage = [
    await tenant("--name Acme --slug acme"),
    await tenant("--name Acme --slug acme --admin-email not-an-email"),
    await tenant(`--name Acme --slug acme ${fay} --colour red`),
    await tenant(`--slug acme ${fay}`),
    await workspace(`--name Sales --slug sales ${fay}`),
    await workspace("--org acme --name Sales --slug sales --admin-email"),
  ];
  for (const { code, codes } of usage) assert.deepEqual([code, codes], [2, ["usage"]]);
  assert.deepEqual(await counts(), { users: 0, organizations: 0, workspaces: 0, memberships: 0 });

  appMailFake.failNext("mail_unreachable");
  const failed = await tenant(`--name Acme --slug acme ${fay}`);
  const made = ["organization_created", "mail_unreachable", "sign_in_page"];
  assert.deepEqual([failed.code, failed.codes], [3, made]);
  assert.equal(await allowSignIn("fay@example.test"), true);

  process.env.APP_PUBLIC_ORIGIN = "";
  try {
    const bare = await workspace("--org acme --name Ops --slug ops --admin-email gus@example.test");
    assert.equal(bare.code, 0);
    const skipped =
      "mail_skipped: APP_PUBLIC_ORIGIN is empty, and a path alone is no use in a mail";
    assert.deepEqual(bare.lines.slice(1), [skipped, "sign_in_page: /sign-in"]);
    assert.equal(mailsTo("gus@example.test"), 0);
  } finally {
    process.env.APP_PUBLIC_ORIGIN = ORIGIN;
  }
});

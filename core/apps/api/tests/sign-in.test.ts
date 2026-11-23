// The host's sign-in routes (src/sign-in.ts) on identity's hooks and the fake adapter, in a schema of
// the worktree's database: asking for a link answers an invited and a refused email alike, in status,
// body and time, and mails the invited one only, once the answer is sent; the link lands on `next`, or
// on / when `next` is no page of the app; signing out ends the sessions and clears the cookie; an
// expired or a revoked invite is refused as no invite is (gamma-p6-020).
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { authHooks, createInvite, revokeInvite } from "@whytide/identity";
import { useIdentityClient, useIdentityClock } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { type AuthMail, authPort, getAdapter } from "@whytide/providers";
import { createTwoWorkspaces, useTenancyClient } from "@whytide/tenancy/testing";
import type { ModuleLoader } from "../src/modules.ts";
import { protectionConfig } from "../src/protection/config.ts";
import { WINDOW_MS } from "../src/protection/rate-limit.ts";
import { type Api, start } from "../src/start.ts";

const db = withTestDb();
useTenancyClient(asRole("app"));
useIdentityClient(asRole("app"));
const modules: ModuleLoader[] = [
  { name: "tenancy", load: () => import("@whytide/tenancy") },
  { name: "identity", load: () => import("@whytide/identity") },
];
/** What the mail hook was given. It takes 200 ms, which an answer that waited for it would show. */
const mailed: AuthMail[] = [];
const sameOrigin = { "sec-fetch-site": "same-origin" };
let api: Api;

before(async () => {
  const auth = await getAdapter(authPort, "fake");
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  // The sign-in routes' rate limit counts per address and minute: a minute no other run used.
  const minute = (Math.floor(Date.now() / WINDOW_MS) + randomInt(1_000, 1_000_000)) * WINDOW_MS;
  api = await start({
    port: 0,
    auth,
    log: createLogger({ destination: collectLogs().destination }),
    modules,
    migrations: { url: migrations.toString() },
    clients: { app: asRole("app"), owner: asRole("owner") },
    now: () => minute,
  });
  const send = async (mail: AuthMail) => {
    await delay(200);
    mailed.push(mail);
  };
  await auth.configure({ ...authHooks, mail: { send } });
});
after(() => api?.close());

async function ask(email: string, next?: string, from?: string) {
  const started = performance.now();
  const res = await fetch(new URL("/v1/sign-in", api.url), {
    method: "POST",
    // A loopback peer is a trusted proxy: X-Forwarded-For names the client's address.
    headers: { "content-type": "application/json", ...(from && { "x-forwarded-for": from }) },
    body: JSON.stringify(next === undefined ? { email } : { email, next }),
  });
  return { status: res.status, body: await res.text(), ms: performance.now() - started };
}

async function invited(): Promise<string> {
  const [a] = await createTwoWorkspaces();
  const email = `ada-${randomUUID()}@example.com`;
  await createInvite({ workspaceId: a.workspace.id, email, role: "Owner", invitedBy: null });
  return email;
}

/** The mails to the email, once there are `count`, or after 5 s. */
async function mailsTo(email: string, count: number): Promise<AuthMail[]> {
  const deadline = Date.now() + 5_000;
  let own = mailed.filter((mail) => mail.to === email);
  while (own.length < count && Date.now() < deadline) {
    await delay(50);
    own = mailed.filter((mail) => mail.to === email);
  }
  return own;
}

test("asking for a link: an invited and a refused email get the same 202, body and time; only the invited one is mailed, and the refused one has no user", async () => {
  const emails = { invited: [] as string[], refused: [] as string[] };
  const times = { invited: [] as number[], refused: [] as number[] };
  for (let run = 0; run < 4; run++) {
    for (const kind of ["invited", "refused"] as const) {
      const email = kind === "invited" ? await invited() : `nobody-${randomUUID()}@example.com`;
      const { status, body, ms } = await ask(email);
      assert.deepEqual([status, body], [202, ""], kind);
      emails[kind].push(email);
      if (run > 0) times[kind].push(ms); // the first run warms up
    }
  }
  const gap = Math.abs(Math.min(...times.invited) - Math.min(...times.refused));
  assert.ok(gap < 100, `the best of three answers differ by ${Math.round(gap)} ms`);
  for (const email of emails.invited) assert.equal((await mailsTo(email, 1)).length, 1, email);
  assert.deepEqual(
    mailed.filter((mail) => emails.refused.includes(mail.to)),
    [],
  );
  const users = await asRole("app").user.count({ where: { email: { in: emails.refused } } });
  assert.equal(users, 0);
});

test("the link lands on `next`, on / when `next` is no page of the app; sign-out ends the sessions and clears the cookie", async () => {
  const email = await invited();
  const land = async (next: string) => {
    const before = (await mailsTo(email, 0)).length;
    assert.equal((await ask(email, next)).status, 202);
    const mail = (await mailsTo(email, before + 1))[before];
    const path = /\/api\/auth\/\S+/.exec(mail?.text ?? "")?.[0] ?? "/no-link";
    const init = { method: "POST", redirect: "manual", headers: sameOrigin } as const;
    const res = await fetch(new URL(path, api.url), init);
    const cookie = res.headers.getSetCookie()[0]?.split(";")[0] ?? "";
    return { location: res.headers.get("location"), cookie };
  };
  assert.equal((await land("/%2F/evil.example")).location, "/");
  const { location, cookie } = await land("/w/main/leads?view=new");
  assert.equal(location, "/w/main/leads?view=new");
  const me = () => fetch(new URL("/v1/me", api.url), { headers: { cookie } });
  assert.equal((await me()).status, 200);
  const headers = { cookie, ...sameOrigin };
  const out = await fetch(new URL("/v1/sign-out", api.url), { method: "POST", headers });
  assert.equal(out.status, 204);
  const cleared = "whytide_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax";
  assert.equal(out.headers.get("set-cookie"), cleared);
  assert.equal((await me()).status, 401);
});

test("asking for a link counts 3 a minute per email and RATE_LIMIT_AUTH_PER_IP_PER_MIN per address", async () => {
  const status = async (email: string, from: string) => (await ask(email, undefined, from)).status;
  const email = `limit-${randomUUID()}@example.com`;
  const byEmail: number[] = [];
  const byAddress: number[] = [];
  for (const n of [1, 2, 3, 4]) byEmail.push(await status(email, `203.0.113.${n}`));
  assert.deepEqual(byEmail, [202, 202, 202, 429]);
  const limit = protectionConfig.RATE_LIMIT_AUTH_PER_IP_PER_MIN;
  for (let n = 0; n <= limit; n++) byAddress.push(await status(`${n}-${email}`, "198.51.100.7"));
  assert.deepEqual(byAddress, [...Array(limit).fill(202), 429]);
});

test("an expired or a revoked invite is refused: no mail, the link's sign-in 403 auth_invite_required, and no user", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const late = `late-${randomUUID()}@example.com`;
  const gone = `gone-${randomUUID()}@example.com`;
  const input = { workspaceId, role: "Member", invitedBy: a.user.id } as const;
  // Made eight days ago: expired today.
  useIdentityClock(() => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000));
  await createInvite({ ...input, email: late });
  useIdentityClock(undefined);
  const { id } = await createInvite({ ...input, email: gone });
  const run = { workspaceId, principal: servicePrincipal("identity_test") };
  await withTenant(run, () => revokeInvite(id, a.user.id), { client: asRole("app") });
  for (const email of [late, gone]) {
    assert.equal((await ask(email, undefined, "192.0.2.20")).status, 202);
    const res = await fetch(new URL("/api/auth/fake/sign-in", api.url), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "192.0.2.20" },
      body: JSON.stringify({ email }),
    });
    assert.deepEqual([res.status, await res.json()], [403, { code: "auth_invite_required" }]);
  }
  await delay(400); // a mail would have been sent by now
  assert.deepEqual(
    mailed.filter((mail) => mail.to === late || mail.to === gone),
    [],
  );
  const users = await asRole("app").user.count({ where: { email: { in: [late, gone] } } });
  assert.equal(users, 0);
});

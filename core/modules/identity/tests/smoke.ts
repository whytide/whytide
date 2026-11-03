// identity's smoke step (README.md "The smoke test"), which `pnpm smoke` runs after the api's health
// check, and checks the health first itself: SMOKE_EMAIL invited by `pnpm invite`'s code to the first
// workspace, never making it (with no organization the step stops: the first real invite makes it);
// a link asked for, read from Mailpit (MAILPIT_API_URL) and followed as the confirm page
// does, a GET then a POST; then GET /v1/me with the session, which must list an Owner membership. The
// api is API_PUBLIC_URL, or 127.0.0.1:API_PORT; a link is followed on it whatever host the mail names.
// core/apps/api/tests/smoke.test.ts runs the step against a started api.
import { setTimeout as delay } from "node:timers/promises";
import { readMailpit } from "@whytide/providers/app-mail/testing";
import { hasOrganization } from "@whytide/tenancy";
import { runInvite } from "../cli/invite.ts";
import { settings } from "../settings.ts";

const json = { "content-type": "application/json" };

function expect(ok: boolean, failure: string): asserts ok {
  if (!ok) throw new Error(`smoke: ${failure}`);
}

/** The latest mail's id, then the link of a newer one, as a URL on the api. */
async function nextLink(api: string, email: string, seen: string | null): Promise<URL> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const mail = await readMailpit({ to: email }, { timeoutMs: 1_000 }).catch(() => null);
    const path = mail?.messageId === seen ? undefined : /\/api\/auth\/\S+/.exec(mail?.text ?? "");
    if (path) return new URL(path[0], api);
    expect(Date.now() < deadline, `no sign-in mail to ${email} in Mailpit after 15 s`);
    await delay(200);
  }
}

/** Signs `email` in on the api and returns the session, for another module's smoke step. */
export async function smokeSignIn(api: string, email: string, say: (line: string) => void) {
  const health = await fetch(new URL("/health", api));
  expect(health.status === 200, `GET /health answered ${health.status}`);
  expect(await hasOrganization(), "no organization: the first `pnpm invite <email>` makes it");
  expect((await runInvite([email], say)) === 0, `pnpm invite refused ${email}`);
  const latest = readMailpit({ to: email }, { timeoutMs: 0 });
  const seen = await latest.then(
    ({ messageId }) => messageId,
    () => null,
  );
  const body = JSON.stringify({ email });
  const asked = await fetch(new URL("/v1/sign-in", api), { method: "POST", headers: json, body });
  expect(asked.status === 202, `POST /v1/sign-in answered ${asked.status}`);
  const link = await nextLink(api, email, seen);
  const page = await fetch(link, { redirect: "manual" });
  expect(page.status === 303, `the link's GET answered ${page.status}, not the confirm page`);
  const headers = { origin: new URL(api).origin };
  const followed = await fetch(link, { method: "POST", redirect: "manual", headers });
  const cookie = followed.headers.getSetCookie()[0]?.split(";")[0] ?? "";
  expect(followed.status === 303 && cookie !== "", `the link's POST answered ${followed.status}`);
  const me = await fetch(new URL("/v1/me", api), { headers: { cookie } });
  const { memberships = [] } = (await me.json()) as { memberships?: Membership[] };
  const owner = memberships.find((membership) => membership.role === "Owner");
  expect(owner !== undefined, `GET /v1/me answered ${me.status} with no Owner membership`);
  say(`smoke: ${email} signed in, Owner of the workspace ${owner.slug}`);
  return { cookie, slug: owner.slug };
}

type Membership = { readonly slug: string; readonly role: string };

if (import.meta.main) {
  const api = process.env.API_PUBLIC_URL || `http://127.0.0.1:${process.env.API_PORT ?? 3001}`;
  // The exit closes the database clients the invite opened.
  await smokeSignIn(api, settings.SMOKE_EMAIL, (line) => console.log(line)).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}

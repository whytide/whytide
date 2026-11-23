// enrichment's phones route end to end (gamma-wr-100; core/modules/enrichment/README.md "The Email
// panel"): the host started with identity, contacts and enrichment, on the fake authentication
// adapter, in a schema of the worktree's database, answering real HTTP. GET …/leads/<personId>/phones
// answers each number a public page printed with the person and the page, oldest first, never a
// provider's or a source's name; a person with none answers an empty list; another workspace's
// person and an unknown one are 404 enrichment_person_not_found; a user of another workspace is 403.
// The route is read-only: it writes nothing, and it never answers an address.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { upsertPersonFromSource } from "@whytide/contacts";
import { useHashSalt } from "@whytide/contacts/testing";
import { databaseUrl, withTenant } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, servicePrincipal } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import {
  createMembership,
  createTwoWorkspaces,
  createUser,
  type TestTenant,
  useTenancyClient,
} from "@whytide/tenancy/testing";
import type { Api } from "../src/start.ts";

const APP_ORIGIN = "https://app.whytide.test";
process.env.APP_PUBLIC_ORIGIN = APP_ORIGIN;
const { start } = await import("../src/start.ts");

const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
useHashSalt("test-salt-".repeat(4));
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "contacts", load: () => import("@whytide/contacts") },
      { name: "enrichment", load: () => import(built("enrichment/dist")) },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const AT = {
  first: "2026-11-18T08:00:00.000Z",
  second: "2026-11-19T09:00:00.000Z",
};
const PAGE = "https://acme.test/team";

type Answer = { status: number; body: any };
/** GET …/enrichment/leads/<personId>/phones as the user. */
async function phones(user: string, workspaceId: string, personId: string): Promise<Answer> {
  const cookie = signInAs(user).map(({ name, value }) => `${name}=${value}`);
  const path = `/v1/workspaces/${workspaceId}/enrichment/leads/${personId}/phones`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: await res.json() };
}
const codeOf = ({ status, body }: Answer) => [status, body.code];

/** A workspace with a Member and three persons: Ana with two phones and an address, Bea with none, Cal's phone. */
async function seeded(tenant: TestTenant) {
  const workspaceId = tenant.workspace.id;
  const member = await createUser();
  await createMembership({ userId: member.id, workspaceId, role: "Member" });
  const principal = servicePrincipal("enrichment_test");
  const ids = await withTenant(
    { workspaceId, principal },
    async () => {
      const person = async (slug: string) => {
        const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID()}`;
        const profile = { linkedinUrl, firstName: slug };
        const source = { source: "linkedin", provider: "unipile", profile } as const;
        return (await upsertPersonFromSource(source)).person.id;
      };
      const [ana, bea] = [await person("ana"), await person("bea")];
      return { ana, bea };
    },
    { client: app },
  );
  const point = (personId: string, value: string, kind: string, at: string, pageUrl?: string) =>
    app.contactPoint.create({
      data: {
        ...{ id: `cp_${randomUUID().replaceAll("-", "")}`, workspaceId, personId, value },
        kind: kind as "work_email" | "phone",
        ...(kind === "phone" ? {} : { verification: "valid", verifiedAt: new Date(at) }),
        ...{ sourceClass: "web_page", provider: "research", legalBasis: "legitimate_interest" },
        ...{ acquiredAt: new Date(at), pageUrl: pageUrl ?? null },
      },
    });
  const suffix = randomUUID().slice(0, 8);
  await point(ids.ana, "+48221234569", "phone", AT.second);
  await point(ids.ana, "+48221234567", "phone", AT.first, PAGE);
  await point(ids.ana, `ana.${suffix}@acme.test`, "work_email", AT.first);
  return { ...ids, workspaceId, owner: tenant.user.id, member: member.id };
}

test("GET …/leads/{personId}/phones: each number with its page, the oldest first, a number kept with no page null, an empty list for a person with none, never an address or a provider's name", async () => {
  const [a] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const ana = await phones(seed.member, seed.workspaceId, seed.ana);
  assert.equal(ana.status, 200);
  assert.deepEqual(ana.body, {
    phones: [
      { number: "+48221234567", page: PAGE, acquiredAt: AT.first },
      { number: "+48221234569", page: null, acquiredAt: AT.second },
    ],
  });
  const text = JSON.stringify(ana.body);
  for (const word of ["research", "web_page", "@", "provider"]) {
    assert.equal(text.includes(word), false, word);
  }
  const bea = await phones(seed.owner, seed.workspaceId, seed.bea);
  assert.deepEqual([bea.status, bea.body], [200, { phones: [] }]);
  assert.equal(await app.contactPoint.count({ where: { workspaceId: seed.workspaceId } }), 3);
});

test("refused: another workspace's person and an unknown one are 404 enrichment_person_not_found; a user of another workspace is 403", async () => {
  const [a, b] = await createTwoWorkspaces();
  const seed = await seeded(a);
  const theirs = await seeded(b);
  const notFound = [404, "enrichment_person_not_found"];
  assert.deepEqual(codeOf(await phones(seed.owner, seed.workspaceId, theirs.ana)), notFound);
  assert.deepEqual(codeOf(await phones(seed.owner, seed.workspaceId, "per_unknown")), notFound);
  const forbidden = await phones(b.user.id, seed.workspaceId, seed.ana);
  assert.deepEqual(codeOf(forbidden), [403, "forbidden"]);
});

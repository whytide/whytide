// A person a signal run finds keeps their member id (gamma-p5-020; core/modules/signals/README.md
// "Processing"), the key campaigns' first invite reads (beta-p4-030), on the sender's fixture
// (fixtures/campaigns-sender.ts) and the LinkedIn fake: a lead whose connection request is ready and
// whose person has no member ref, as signals left one before; a run of the account's own posts whose
// engager is that person reads their profile and stores the ref under unipile; the sender's invite
// then carries it, with no profile read of its own.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { callsOf, storedRef, unknownLead } from "./fixtures/campaigns-member-reference.ts";
import { app, fake, sender, sends, useSenderTests } from "./fixtures/campaigns-sender.ts";

const { asRole } = await import("@whytide/db/testing");
const { collectLogs, createLogger, newId } = await import("@whytide/platform");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { runWorkflow } = await import("../testing/index.ts");
const built = (path: string) => import(new URL(`../../../modules/${path}`, import.meta.url).href);
const { assemblePrices, syncPrices } = await built("credits/dist/domain/prices.js");
const prices = ["campaigns", "signals"].map(
  (name) => new URL(`../../../modules/${name}/dist/prices.js`, import.meta.url).href,
);

useSenderTests();
const log = createLogger({ destination: collectLogs().destination });
// The run's modules, credits and linkedin beside signals, loaded again: the fixture starts them.
const names = new Set(["credits", "linkedin", "signals"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app, log })];
  }),
);
const POST = `https://www.linkedin.com/feed/update/urn:li:activity:${Date.now()}`;

/** campaigns' and signals' prices as the api's start writes them: a profile read costs a credit. */
async function writePrices() {
  const script = [
    'const { registeredPrices } = await import("@whytide/platform");',
    ...prices.map((url) => `await import(${JSON.stringify(url)});`),
    "process.stdout.write(JSON.stringify([...registeredPrices().values()]));",
  ].join("\n");
  const declared = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test" },
    encoding: "utf8",
  });
  assert.equal(declared.status, 0, declared.stderr);
  await syncPrices(asRole("billing_writer"), assemblePrices(JSON.parse(declared.stdout), {}), log);
}

test("a person an own-posts run finds has their member id stored under unipile, and the sender's invite to them carries it with no profile read", async () => {
  const s = await sender();
  await writePrices();
  await app.organization.update({ where: { id: s.organizationId }, data: { name: "Ortolan" } });
  const step = await unknownLead(s, "noor", "Noor, I read your post on pipeline reviews");
  assert.equal(await storedRef(step.personId), null);
  const who = { providerMemberRef: step.memberRef, profileUrl: step.linkedinUrl };
  fake.seedProfile({
    ...{ ...who, firstName: "Noor", lastName: "Haddad", headline: "Head of Sales" },
    ...{ title: "Head of Sales", companyName: "Blue Harbor", locationText: "Berlin, Germany" },
  });
  const owner = { providerMemberRef: "ref-owner", profileUrl: "https://www.linkedin.com/in/owner" };
  const author = { kind: "member" as const, ...owner, name: "The Owner", headline: "Founder" };
  const postedAt = new Date(Date.now() - 86_400_000);
  fake.seedOwnPosts(s.ref, [{ postUrl: POST, postedAt, excerpt: "Pipeline reviews", author }]);
  const engagedAt = new Date(Date.now() - 3_600_000);
  const like = {
    ...who,
    name: "Noor Haddad",
    headline: "Head of Sales",
    reaction: "like" as const,
  };
  fake.seedPost(POST, [{ ...like, engagedAt }]);
  const source = await app.signalSource.create({
    data: {
      ...{ id: newId("src"), workspaceId: s.workspaceId, kind: "my_post_engagement", config: {} },
      ...{ label: "My posts", senderAccountId: s.accountId, createdBy: "usr_sender_owner" },
    },
  });
  const input = { workspaceId: s.workspaceId, sourceId: source.id };
  const ran = await runWorkflow<{ status: string }>("signals_run", input, { activities });
  assert.equal(ran.status, "done");
  assert.equal(await storedRef(step.personId), step.memberRef);
  assert.equal(callsOf("getProfile").length, 1);

  const { result } = await s.send();
  assert.deepEqual(result, { sent: 1, blocked: 0, refused: 0, end: "no_step" });
  const [invite, ...more] = sends();
  assert.deepEqual(more, []);
  assert.equal((invite?.input as { memberRef: string }).memberRef, step.memberRef);
  assert.equal(callsOf("getProfile").length, 1, "the invite read the profile again");
});

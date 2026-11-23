// qualification's Hot alert (gamma-p5-065; core/modules/qualification/README.md "The Hot alert",
// docs/flows.md), on the slice's Temporal and a schema of its database, the app-mail and LLM fakes
// bound: qualification loaded from its build by the worker's own loader, its workflows run by the
// host. A Hot lead's qualification.lead_hot, delivered by the host's outbox: the subscriber claims
// the alert and starts qualification_hot_alert by the event's id, and one mail goes to the member
// who created the why-now signal's source, with the lead's link, none of the person's data; the
// host's log lines hold ids only. The event delivered again starts no second run. With
// APP_PUBLIC_ORIGIN empty, the mail goes without a link; a member who left gets none, and the
// workflow ends without an error. The recorded history replays. The intent row is written straight
// in the table, as the intent write leaves it (core/modules/qualification/tests/hot-alert.test.ts
// covers the write). It lives here: a module never imports a host.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { TenantClient } from "@whytide/db";

// The fakes, whatever the environment names: nothing here sends a mail or calls a model.
process.env.PROVIDER_APP_MAIL = "fake";
process.env.PROVIDER_LLM = "fake";
const ORIGIN = "https://app.example.test";
process.env.APP_PUBLIC_ORIGIN = ORIGIN;

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { appMailPort, getAdapter } = await import("@whytide/providers");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { start } = await import("../src/start.ts");
const { replayHistories, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const contacts = await import(built("contacts/dist/index.js"));
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { publishLeadHot } = await import(built("qualification/dist/domain/alert/publish.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = asRole("app");
useHashSalt("test-salt-".repeat(4));
tenancy.useTenancyClient(app);
const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
/** The app-mail fake's helpers, which the bound adapter keeps (providers/app-mail/README.md). */
type AppMailFake = { sent(): readonly { to: string; subject: string; text: string }[] };
const mails = (await getAdapter(appMailPort, "fake")) as unknown as AppMailFake;
const principal = platform.servicePrincipal("qualification_test");
const HISTORY = fileURLToPath(
  built("qualification/workflows/__histories__/qualification_hot_alert.json"),
);
const UNTIL_MS = 30_000;
const PERSON = { firstName: "Noor", lastName: "Haddad", companyName: "Qamar Robotics" };

type Run = (workflow: string, input: unknown, workflowId?: string) => Promise<unknown>;

const inRun = <T>(workspaceId: string, fn: (tx: TenantClient) => Promise<T>) =>
  withTenant({ workspaceId, principal }, fn, { client: app });
const mailsTo = (to: string) => mails.sent().filter((mail) => mail.to === to);

/** The first truthy answer of `probe`, asked every 50 ms for 30 seconds at most. */
async function until<T>(probe: () => Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + UNTIL_MS;
  for (;;) {
    const answer = await probe();
    if (answer) return answer;
    if (Date.now() > deadline) throw new Error("until: no answer in 30 seconds");
    await sleep(50);
  }
}

/**
 * A workspace, a Member who created the source, and a Hot lead's intent row whose why-now signal is
 * that source's comment of yesterday, unclaimed: their ids and the Member's address.
 */
async function hotLead() {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const workspaceId: string = workspace.id;
  const member: { id: string; email: string } = await tenancy.createUser();
  await tenancy.createMembership({ userId: member.id, workspaceId, role: "Member" });
  const linkedinUrl = `https://linkedin.com/in/hot-alert-${randomUUID()}`;
  const personId: string = await inRun(workspaceId, async () => {
    const source = { source: "import", provider: "csv", profile: { linkedinUrl, ...PERSON } };
    return (await contacts.upsertPersonFromSource(source)).person.id;
  });
  const at = new Date(Date.now() - 86_400_000).toISOString();
  const part = { eventId: "evt_hot", kind: "competitor_engagement", role: "comment" };
  await app.intentScore.create({
    data: {
      ...{ workspaceId, personId, intentScore: 53, priority: 82, tier: "hot" },
      intentBreakdown: [{ ...part, contribution: 6, at, ownerUserId: member.id }],
      ...{ whyNowEventId: "evt_hot", boostUntil: null, scorerVersion: "intent-v1" },
      computedAt: new Date(),
    },
  });
  return { workspaceId, member, personId, linkedinUrl };
}

/** `fn` with the host started, qualification alone, on a queue of its own; closed after. */
async function withHost(fn: (run: Run) => Promise<void>): Promise<void> {
  const taskQueue = `test-${randomUUID()}`;
  const modules = moduleLoaders.filter(({ name }) => name === "qualification");
  const host = await start({
    modules,
    taskQueue,
    healthPort: 0,
    schedules: "off",
    client: app,
    log,
  });
  const run: Run = (workflow, input, workflowId = `${workflow}-${randomUUID()}`) =>
    env.client.workflow.execute(workflow, { args: [input], taskQueue, workflowId });
  try {
    await fn(run);
  } finally {
    await host.close();
  }
}

test("a lead that turned Hot: the outbox delivers lead_hot, the subscriber claims the alert and starts its run by the event's id, one mail to the source's creator with the lead's link and none of the person's data, the log lines with ids only; delivered again, no second run", () =>
  withHost(async () => {
    const { workspaceId, member, personId, linkedinUrl } = await hotLead();
    const eventId: string = await inRun(workspaceId, () => publishLeadHot(personId));
    const alert = env.client.workflow.getHandle(
      `qualification.hot_alert:${workspaceId}:${eventId}`,
    );
    await until(() => alert.describe().catch(() => null));
    assert.deepEqual(await alert.result(), { sent: true });

    const [mail, ...more] = mailsTo(member.email);
    assert.ok(mail);
    assert.equal(more.length, 0, "one mail");
    const link = `${ORIGIN}/w/${workspaceId}/leads/${personId}`;
    assert.deepEqual(mail.text.match(/https?:\/\/\S+/g), [link], "the lead's link, alone");
    assert.match(mail.text, /^Why now: a comment on a competitor’s post, 1 day ago\.$/m);
    const person = [...Object.values(PERSON), linkedinUrl];
    for (const value of person) assert.ok(!`${mail.subject}\n${mail.text}`.includes(value), value);
    const row = await app.intentScore.findFirstOrThrow({ where: { workspaceId, personId } });
    assert.ok(row.hotAlertedAt instanceof Date, "hot_alerted_at is set");

    const line = logs.lines().find(({ msg }) => msg === "qualification: the Hot alert");
    assert.deepEqual(
      [line?.person_id, line?.user_id, line?.outcome],
      [personId, member.id, "sent"],
    );
    const logged = logs.raw.join("");
    for (const value of [...person, member.email]) assert.ok(!logged.includes(value), value);

    const { runId } = await alert.describe();
    const event = await app.outboxEntry.findUniqueOrThrow({ where: { id: eventId } });
    assert.deepEqual(event.payload, { workspaceId, personId }, "ids only");
    await app.outboxEntry.update({ where: { id: eventId }, data: { deliveredAt: null } });
    await until(async () => {
      const again = await app.outboxEntry.findUniqueOrThrow({ where: { id: eventId } });
      return again.deliveredAt;
    });
    assert.equal((await alert.describe()).runId, runId, "the same run, none after it");
    assert.equal(mailsTo(member.email).length, 1, "still one mail");
  }));

test("with APP_PUBLIC_ORIGIN empty the mail has no link and still goes; a member who left gets none, and the workflow ends without an error", (t) =>
  withHost(async (run) => {
    const { workspaceId, member, personId } = await hotLead();
    const workflowId = `qualification_hot_alert-${randomUUID()}`;
    process.env.APP_PUBLIC_ORIGIN = "";
    try {
      const input = { workspaceId, personId };
      assert.deepEqual(await run("qualification_hot_alert", input, workflowId), { sent: true });
    } finally {
      process.env.APP_PUBLIC_ORIGIN = ORIGIN;
    }
    // The run whose history is workflows/__histories__/qualification_hot_alert.json (history:record).
    t.diagnostic(`qualification_hot_alert ran as ${workflowId}`);
    const [mail] = mailsTo(member.email);
    assert.ok(mail);
    assert.doesNotMatch(mail.text, /https?:|\/w\//, "no link and no path");

    const left = await hotLead();
    await app.membership.deleteMany({ where: { userId: left.member.id } });
    const input = { workspaceId: left.workspaceId, personId: left.personId };
    assert.deepEqual(await run("qualification_hot_alert", input), {
      sent: false,
      reason: "member_left",
    });
    assert.deepEqual(mailsTo(left.member.email), [], "no mail");
  }));

test("the recorded history of qualification_hot_alert replays", () =>
  replayHistories(env.workflowsPath, [HISTORY]));

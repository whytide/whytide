// campaigns' enrollment route end to end (beta-p2-060; core/modules/campaigns/README.md "Routes"):
// the host started with identity and campaigns, on the fake authentication adapter, in a schema of
// the worktree's database, answering real HTTP. A person's enrollments newest first, at most 20, each
// with its steps by position and its sender account's time zone, null without a sender and for an
// account linkedin no longer holds; personId required; another workspace's rows never in the answer,
// the same person id's included; campaigns.read required. The enrollments and their steps are
// written to the tables as campaigns leaves them, the account by linkedin's factory. It lives here: a
// module never imports a host.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { databaseUrl, type Prisma } from "@whytide/db";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useIdentityClient } from "@whytide/identity/testing";
import { collectLogs, createLogger, newId } from "@whytide/platform";
import { signInAs } from "@whytide/providers/auth/testing";
import { createTwoWorkspaces, createUser, useTenancyClient } from "@whytide/tenancy/testing";
import { type Api, start } from "../src/start.ts";

// The modules by their builds' paths, as src/modules.generated.ts loads them: the api lists no module
// with a screen (core/apps/web/docs/screens.md).
const built = (path: string) =>
  new URL(`../../../../modules/${path}/index.js`, import.meta.url).href;
type Campaigns = typeof import("../../../modules/campaigns/dist/index.js");
type LinkedinTesting = typeof import("../../../modules/linkedin/dist/testing/index.js");
const campaigns: Campaigns = await import(built("campaigns/dist"));
const linkedin: LinkedinTesting = await import(built("linkedin/dist/testing"));

const db = withTestDb();
const app = asRole("app");
useTenancyClient(app);
useIdentityClient(app);
linkedin.useLinkedinClient(app);
let api: Api;

before(async () => {
  const migrations = new URL(databaseUrl("owner"));
  migrations.searchParams.set("schema", db.schema);
  api = await start({
    port: 0,
    log: createLogger({ destination: collectLogs().destination }),
    modules: [
      { name: "identity", load: () => import("@whytide/identity") },
      { name: "campaigns", load: async () => campaigns },
    ],
    migrations: { url: migrations.toString() },
    clients: { app, owner: asRole("owner") },
  });
});
after(() => api?.close());

const TEMPLATE = { templateId: "linkedin_default", templateVersion: 1 };
const T0 = Date.parse("2026-10-26T09:00:00.000Z");
const HOUR = 3_600_000;
const at = (hours: number) => new Date(T0 + hours * HOUR);

type Enrollment = Omit<
  Prisma.EnrollmentUncheckedCreateInput,
  "id" | "workspaceId" | "personId" | "templateId" | "templateVersion" | "sourceEventId"
>;
type Step = Pick<
  Prisma.StepExecutionUncheckedCreateInput,
  | "stepKey"
  | "position"
  | "actionType"
  | "status"
  | "dueAt"
  | "scheduledFor"
  | "executedAt"
  | "skipReason"
  | "errorCode"
>;

/** An enrollment of the person and its steps, written as campaigns leaves them; its id. */
async function enroll(workspaceId: string, personId: string, row: Enrollment, steps: Step[] = []) {
  const id = newId(campaigns.ids.enrollment);
  const sourceEventId = newId("obx");
  await app.enrollment.create({
    data: { ...row, id, workspaceId, personId, ...TEMPLATE, sourceEventId },
  });
  for (const step of steps) {
    const keys = { stepTemplateHash: step.stepKey, idempotencyKey: `${id}:${step.stepKey}` };
    await app.stepExecution.create({
      data: {
        ...{ ...step, ...keys, ...TEMPLATE, id: newId(campaigns.ids.step_execution) },
        ...{ workspaceId, enrollmentId: id, personId, senderAccountId: `${row.senderAccountId}` },
      },
    });
  }
  return id;
}

/** GET …/campaigns/enrollments<query> of the workspace, signed in as the user. */
async function read(userId: string, workspaceId: string, query: string) {
  const cookie = signInAs(userId).map(({ name, value }) => `${name}=${value}`);
  const path = `/v1/workspaces/${workspaceId}/campaigns/enrollments${query}`;
  const res = await fetch(new URL(path, api.url), { headers: { cookie: cookie.join("; ") } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("GET …/campaigns/enrollments?personId= answers the person's enrollments newest first, each with its steps by position and its sender account's time zone; null without a sender and for an account linkedin no longer holds", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const personId = "per_enrollments_route";
  const sender = await linkedin.createConnectedAccount(workspaceId, { timeZone: "Asia/Kolkata" });
  const replied = await enroll(workspaceId, personId, {
    ...{ status: "replied", senderAccountId: "sac_gone", startedAt: at(0), endedAt: at(1) },
    createdAt: at(0),
  });
  const refused = await enroll(workspaceId, personId, {
    ...{ status: "exited", exitReason: "no_sender", endedAt: at(2) },
    createdAt: at(2),
  });
  const active = { status: "active", senderAccountId: sender.id, startedAt: at(3) } as const;
  // Written last position first: the answer orders them by position.
  const activeId = await enroll(workspaceId, personId, { ...active, createdAt: at(3) }, [
    { stepKey: "follow_up_2", position: 4, actionType: "message", status: "planned" },
    {
      ...{ stepKey: "follow_up_1", position: 3, actionType: "message", status: "skipped" },
      skipReason: "never_contact_person",
    },
    {
      ...{ stepKey: "message_1", position: 2, actionType: "message", status: "scheduled" },
      ...{ dueAt: at(5), scheduledFor: at(6), errorCode: "touched_today" },
    },
    {
      ...{ stepKey: "connect", position: 1, actionType: "invite", status: "succeeded" },
      ...{ dueAt: at(3), executedAt: at(4) },
    },
  ]);

  const step = (stepKey: string, actionType: string, status: string) => ({
    ...{ stepKey, actionType, status, dueAt: null, scheduledFor: null, executedAt: null },
    ...{ skipReason: null, errorCode: null },
  });
  const enrollment = (id: string, status: string) => ({
    ...{ id, status, exitReason: null, exitDetail: null, startedAt: null, endedAt: null },
    ...{ ...TEMPLATE, timeZone: null, steps: [] },
  });
  assert.deepEqual(await read(a.user.id, workspaceId, `?personId=${personId}`), {
    status: 200,
    body: {
      enrollments: [
        {
          ...enrollment(activeId, "active"),
          ...{ startedAt: at(3).toISOString(), timeZone: "Asia/Kolkata" },
          steps: [
            {
              ...step("connect", "invite", "succeeded"),
              ...{ dueAt: at(3).toISOString(), executedAt: at(4).toISOString() },
            },
            {
              ...step("message_1", "message", "scheduled"),
              ...{ dueAt: at(5).toISOString(), scheduledFor: at(6).toISOString() },
              errorCode: "touched_today",
            },
            {
              ...step("follow_up_1", "message", "skipped"),
              skipReason: "never_contact_person",
            },
            step("follow_up_2", "message", "planned"),
          ],
        },
        {
          ...enrollment(refused, "exited"),
          ...{ exitReason: "no_sender", endedAt: at(2).toISOString() },
        },
        {
          ...enrollment(replied, "replied"),
          ...{ startedAt: at(0).toISOString(), endedAt: at(1).toISOString() },
        },
      ],
    },
  });
  // A person without an enrollment, or no person at all: none.
  const none = { status: 200, body: { enrollments: [] } };
  assert.deepEqual(await read(a.user.id, workspaceId, "?personId=per_unknown"), none);
});

test("GET …/campaigns/enrollments answers the newest 20 of a person's enrollments", async () => {
  const [a] = await createTwoWorkspaces();
  const workspaceId = a.workspace.id;
  const personId = "per_enrollments_many";
  const exited = { status: "exited", exitReason: "suppressed", exitDetail: "opted_out" } as const;
  const ids: string[] = [];
  for (let hours = 0; hours <= 20; hours++) {
    ids.push(
      await enroll(workspaceId, personId, { ...exited, endedAt: at(hours), createdAt: at(hours) }),
    );
  }
  const { status, body } = await read(a.user.id, workspaceId, `?personId=${personId}`);
  assert.equal(status, 200);
  const answered = body.enrollments as { id: string; exitDetail: string }[];
  assert.deepEqual(
    answered.map(({ id }) => id),
    ids.slice(1).reverse(),
    "the newest 20, newest first; the oldest left out",
  );
  assert.ok(answered.every(({ exitDetail }) => exitDetail === "opted_out"));
});

test("GET …/campaigns/enrollments without personId, or with an empty one, is 400 validation_failed", async () => {
  const [a] = await createTwoWorkspaces();
  const refused = {
    status: 400,
    body: { code: "validation_failed", details: { fields: ["personId"] } },
  };
  assert.deepEqual(await read(a.user.id, a.workspace.id, ""), refused);
  assert.deepEqual(await read(a.user.id, a.workspace.id, "?personId="), refused);
});

test("GET …/campaigns/enrollments never answers another workspace's enrollments, a person id they share included", async () => {
  const [a, b] = await createTwoWorkspaces();
  const ofB = "per_enrollments_b";
  const shared = "per_enrollments_shared";
  const refused = { status: "exited", exitReason: "no_sender", endedAt: at(0) } as const;
  const onlyB = await enroll(b.workspace.id, ofB, { ...refused, createdAt: at(0) });
  await enroll(b.workspace.id, shared, { ...refused, createdAt: at(1) });
  const ownA = await enroll(a.workspace.id, shared, { ...refused, createdAt: at(0) });

  const idsOf = async (tenant: typeof a, personId: string) => {
    const { status, body } = await read(
      tenant.user.id,
      tenant.workspace.id,
      `?personId=${personId}`,
    );
    assert.equal(status, 200);
    return (body.enrollments as { id: string }[]).map(({ id }) => id);
  };
  assert.deepEqual(await idsOf(a, ofB), []);
  assert.deepEqual(await idsOf(a, shared), [ownA]);
  assert.deepEqual(await idsOf(b, ofB), [onlyB]);
});

test("campaigns.read is required: a signed-in user who is no member of the workspace gets 403", async () => {
  const [a] = await createTwoWorkspaces();
  const nobody = await createUser();
  assert.deepEqual(await read(nobody.id, a.workspace.id, "?personId=per_enrollments_route"), {
    status: 403,
    body: { code: "forbidden" },
  });
});

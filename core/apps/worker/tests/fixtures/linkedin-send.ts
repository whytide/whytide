// The send activities' fixture (tests/linkedin-send.test.ts, tests/safety/): linkedin and tenancy
// loaded from their builds, as the worker loads a module, on the LinkedIn and files fakes, set here
// before the providers load. A connected account of a new workspace with a reference the fake knows,
// sending open, on linkedin's clock at a Thursday 10:00 UTC; a step's request file under raw/ and its
// key's reservation; an activity called by name, directly in a context of the test's (a worker killed
// after the call is a run that fails once the fake recorded a send), or on the slice's Temporal
// through the host's wrapper (useTemporal), whose history decodes to text.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeEach } from "node:test";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const { collectLogs, createLogger, loadMasterKeys, newId, newMasterKey, servicePrincipal } =
  await import("@whytide/platform");
const { filesPort, getAdapter, linkedinPort } = await import("@whytide/providers");
const { historyToJSON } = await import("@temporalio/common/lib/proto-utils.js");
const { hostActivity } = await import("../../src/activities.ts");
const { moduleLoaders } = await import("../../src/modules.generated.ts");
const { loadModules } = await import("../../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../../testing/index.ts");

// The modules by their builds' paths, as the loader imports them: the worker depends on neither.
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
type LinkedinTesting = typeof import("../../../../modules/linkedin/dist/testing/index.js");
type Reserve = typeof import("../../../../modules/linkedin/dist/domain/send/reserve.js");
type Settle = typeof import("../../../../modules/linkedin/dist/domain/send/settle.js");
type Quota = typeof import("../../../../modules/linkedin/dist/domain/quota/reservations.js");
type Outreach = typeof import("../../../../modules/linkedin/dist/domain/send/outreach.js");
type TenancyTesting = typeof import("../../../../modules/tenancy/dist/testing/index.js");
export const linkedin: LinkedinTesting = await built("linkedin/dist/testing/index.js");
export const { reserveSend }: Reserve = await built("linkedin/dist/domain/send/reserve.js");
export const settle: Settle = await built("linkedin/dist/domain/send/settle.js");
export const quota: Quota = await built("linkedin/dist/domain/quota/reservations.js");
export const outreach: Outreach = await built("linkedin/dist/domain/send/outreach.js");
const tenancy: TenancyTesting = await built("tenancy/dist/testing/index.js");
type LinkedinFake = import("@whytide/providers").LinkedinFake;
type TenantClient = import("@whytide/db").TenantClient;
/** A tenant run, as an activity's context makes one. */
export type Tenant = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
type ActivityContext = { workspaceId: string; workflowId: string; attempt: number; tenant: Tenant };
type Activities = Record<string, (input: never) => Promise<unknown>>;

/** Thursday 22 October 2026, 10:00 UTC: a weekday, in the past, so the fake's times come after it. */
export const THURSDAY = new Date("2026-10-22T10:00:00Z");
const ALWAYS = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
const SEND_METHODS = new Set(["sendInvite", "sendMessage", "withdrawInvite"]);
const principal = servicePrincipal("worker");
const log = createLogger({ destination: collectLogs().destination });
const loaded = await loadModules(moduleLoaders.filter(({ name }) => name === "linkedin"));
export const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const files = await getAdapter(filesPort, "fake");
let clock = THURSDAY;
let app: ReturnType<typeof asRole>;

/** linkedin's clock moved by `ms`. */
export const later = (ms: number): void => void (clock = new Date(clock.getTime() + ms));
/** The send-side calls the fake recorded. */
export const sends = () => fake.recordedCalls.filter(({ method }) => SEND_METHODS.has(method));
export const methods = () => fake.recordedCalls.map(({ method }) => method);
export const db = () => app;

/** The file's schema and hooks, once at its top: each test starts truncated, the fake reset, at THURSDAY. */
export function useSendTests(): void {
  withTestDb();
  app = asRole("app");
  linkedin.useLinkedinClient(app);
  tenancy.useTenancyClient(app);
  linkedin.useSecretKeys(loadMasterKeys({ APP_MASTER_KEY: newMasterKey() }));
  linkedin.useClock(() => clock);
  beforeEach(() => {
    fake.reset();
    clock = THURSDAY;
  });
}

/** A ULID, for the made-up step executions and persons of the request files. */
const ulid = () => newId("sor").slice("sor_".length);

type SendType = "invite" | "message" | "withdraw";
export type Sender = Awaited<ReturnType<typeof sender>>;
export type Step = Awaited<ReturnType<Sender["step"]>>;

/** A connected account of a new workspace, the fake's, and its steps, calls and runs. */
export async function sender() {
  const [{ workspace }] = await tenancy.createTwoWorkspaces();
  const workspaceId = workspace.id;
  const ref = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", ref);
  const options = { providerAccountRef: ref, workingHours: ALWAYS };
  const { id: accountId } = await linkedin.createConnectedAccount(workspaceId, options);
  // The highest targets: room for a test's steps in the day's limits, drawn at its first reservation.
  const targets = { inviteTarget: 15, messageTarget: 40 };
  await app.senderAccount.update({ where: { id: accountId }, data: targets });
  await linkedin.openSending();
  const run: Tenant = (fn) => withTenant({ workspaceId, principal }, fn, { client: app });
  const writeFile = async (body: unknown) => {
    const key = `raw/linkedin/send/${randomUUID()}.json`;
    await files.put({
      workspaceId,
      key,
      body: JSON.stringify(body),
      contentType: "application/json",
    });
    return key;
  };
  /** A send's slot for the key; a refusal fails the test. */
  const reserve = async (idempotencyKey: string, actionType: SendType, withNote = false) => {
    const input = { accountId, actionType, idempotencyKey, withNote };
    const answer = await run(() => reserveSend(input));
    assert.ok("reservationId" in answer, `refused: ${JSON.stringify(answer)}`);
    return answer.reservationId;
  };
  return {
    workspaceId,
    accountId,
    ref,
    run,
    writeFile,
    reserve,
    /** A step of `actionType` to a new member (a relation of the account's for a message): its file and its slot. */
    async step(actionType: SendType, more: Record<string, unknown> = {}) {
      const memberRef = `member-${randomUUID()}`;
      if (actionType === "message") fake.seedRelation(ref, memberRef);
      const text = actionType === "message" ? { text: "Hello" } : {};
      const request = {
        stepExecutionId: `sx_${ulid()}`,
        personId: `per_${ulid()}`,
        actionType,
        memberRef,
        idempotencyKey: `step-${randomUUID()}`,
        ...text,
        ...more,
      };
      const requestKey = await writeFile(request);
      const reservationId = await reserve(request.idempotencyKey, actionType, !!more.note);
      const input = (stepAttempt = 1, slot = reservationId) => ({
        workspaceId,
        accountId,
        reservationId: slot,
        requestKey,
        stepAttempt,
      });
      return { ...request, requestKey, reservationId, input };
    },
    /** Activity `name`, by the worker's definition, called at `attempt`; `tenant` stands in for the runs. */
    call(name: string, input: object, attempt = 1, tenant: Tenant = run): Promise<unknown> {
      const definition = loaded.activities.get(name);
      assert.ok(definition, name);
      const context: ActivityContext = { workspaceId, workflowId: "test", attempt, tenant };
      return definition.run(definition.input.parse(input), context);
    },
    /** `tenant`'s runs, failing once the fake has recorded a send: the worker killed after the call. */
    killedAfterSend(tenant: Tenant = run): Tenant {
      const before = sends().length;
      return (fn) => (sends().length > before ? Promise.reject(new Error("killed")) : tenant(fn));
    },
  };
}

/** The rows naming a step execution or a person in the action log, as `kind:outcome`, sorted. */
export async function rowsOf(objectRef: string): Promise<string[]> {
  const select = { kind: true, outcome: true } as const;
  const rows = await app.senderActionLog.findMany({ where: { objectRef }, select });
  return rows.map(({ kind, outcome }) => `${kind}:${outcome}`).sort();
}

export const reservationOf = (id: string): Promise<{ status: string; expiresAt: Date }> =>
  app.senderQuotaReservation.findUniqueOrThrow({
    where: { id },
    select: { status: true, expiresAt: true },
  });

/**
 * The slice's Temporal for the file, once at its top: `probe` runs the calls in turn, by name, in
 * the fixture's workflow, on the host's wrapper of linkedin's activities (`wrap` replaces one's run);
 * `historyOf` decodes a run's history, its payloads as JSON text.
 */
export function useTemporal() {
  const env = withTestWorkflowEnvironment({
    workflowsPath: join(import.meta.dirname, "linkedin-send-workflows.ts"),
  });
  return {
    async probe(calls: { activity: string; input: object }[], wrap: Record<string, Wrap> = {}) {
      const activities: Activities = {};
      for (const [name, definition] of loaded.activities) {
        const run = wrap[name]?.(definition.run) ?? definition.run;
        activities[name] = hostActivity(name, { ...definition, run }, { client: app, log });
      }
      const options = { activities };
      return runWorkflow<{ workflowId: string; answers: unknown[] }>(
        "linkedin_send_probe",
        { calls },
        options,
      );
    },
    async historyOf(workflowId: string): Promise<string> {
      const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
      const decoded: string[] = [];
      const raw = JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
        const data = (value as { metadata?: unknown; data?: unknown } | null)?.data;
        if (typeof data === "string" && (value as { metadata?: unknown }).metadata) {
          decoded.push(Buffer.from(data, "base64").toString("utf8"));
        }
        return value;
      });
      return [raw, ...decoded].join("\n");
    },
  };
}
type Run = (input: never, context: ActivityContext) => Promise<unknown>;
export type Wrap = (run: Run) => Run;

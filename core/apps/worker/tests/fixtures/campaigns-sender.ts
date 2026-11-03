// The sender's fixture (tests/campaigns-sender.test.ts, tests/safety/sender-workflow.test.ts), on the
// slice's Temporal and a schema of its database: campaigns, linkedin and credits loaded from their
// builds by the worker's own loader and started, their activities through the host's wrapper, on the
// LinkedIn and files fakes, set here before the providers load, the workflow starter bound to a
// recorder. Campaigns' and linkedin's clocks run at the system's pace from a past Thursday at 10:00
// UTC, the account's zone; campaigns_sender_next is wrapped so that a wait longer than WAIT_RUN_MS
// moves both clocks to WAIT_RUN_MS before its end, and the workflow's own timer runs the rest. A lead
// is written as an enrollment leaves it, its steps as the queue, the owner's approval (the item and
// the frozen draft) and the plan leave them; credits' price list as the api's start writes it, from
// campaigns' prices in a process of its own, and the organization's allowance.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { before, beforeEach } from "node:test";
import type { WorkflowStart } from "@whytide/platform";

process.env.PROVIDER_LINKEDIN = "fake";
process.env.PROVIDER_FILES = "fake";

const { withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { filesPort, getAdapter, linkedinPort } = await import("@whytide/providers");
const credits = await import("@whytide/credits/testing");
const { historyToJSON } = await import("@temporalio/common/lib/proto-utils.js");
const { hostActivity } = await import("../../src/activities.ts");
const { moduleLoaders } = await import("../../src/modules.generated.ts");
const { loadModules, startModules } = await import("../../src/modules.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../../testing/index.ts");
const built = (path: string) =>
  import(new URL(`../../../../modules/${path}`, import.meta.url).href);
export const contacts = await built("contacts/dist/index.js");
const { useHashSalt } = await built("contacts/dist/testing/index.js");
const campaigns = await built("campaigns/dist/testing/index.js");
/** How long the sender's gate before the call holds (beta-p4-040); undefined puts it back. */
export const useGateFreshMs: (ms: number | undefined) => void = campaigns.useGateFreshMs;
export const { sentStep } = await built("campaigns/dist/index.js");
const { plannedSteps } = await built("campaigns/dist/domain/enroll/steps.js");
const { ids } = await built("campaigns/dist/ids.js");
export const { MIN_ACTION_GAP_MS } = await built("campaigns/dist/domain/plan/constants.js");
export const { nextDueAt } = await built("campaigns/dist/domain/template/due.js");
export const { senderStart } = await built("campaigns/dist/workflows/index.js");
export const linkedin = await built("linkedin/dist/testing/index.js");
const tenancy = await built("tenancy/dist/testing/index.js");
const { createApprovalItem } = await built("approvals/dist/testing/index.js");
const { createStepDraft } = await built("messaging/dist/testing/index.js");
const { assemblePrices, syncPrices } = await built("credits/dist/domain/prices.js");
const prices = new URL("../../../../modules/campaigns/dist/prices.js", import.meta.url).href;

type LinkedinFake = import("@whytide/providers").LinkedinFake;
type TenantClient = import("@whytide/db").TenantClient;
export type Tenant = <T>(fn: (tx: TenantClient) => Promise<T>) => Promise<T>;
type Context = { workspaceId: string; workflowId: string; attempt: number; tenant: Tenant };
type Run = (input: never, context: Context) => Promise<unknown>;
export type Wrap = (run: Run) => Run;
export type SenderRun = { sent: number; blocked: number; refused: number; end: string };

/** Thursday 22 October 2026, 10:00 UTC: a weekday, in the past. */
export const THURSDAY = new Date("2026-10-22T10:00:00Z");
export const DAY_MS = 86_400_000;
export const OWNER = "usr_sender_owner";
const ALWAYS = { start: "00:00", end: "23:59", days: [1, 2, 3, 4, 5, 6, 7] };
/** What the workflow's own timer runs of a wait; the clocks skip the rest. */
const WAIT_RUN_MS = 250;
const SEND_METHODS = new Set(["sendInvite", "sendMessage", "withdrawInvite"]);
const principal = platform.servicePrincipal("campaigns_test");
export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

let env: ReturnType<typeof withTestWorkflowEnvironment>;
/** The test schema's app role, once useSenderTests has run. */
export let app: ReturnType<typeof asRole>;
export const logs = platform.collectLogs();
const log = platform.createLogger({ destination: logs.destination });
const names = new Set(["campaigns", "credits", "linkedin"]);
const loaded = await loadModules(moduleLoaders.filter(({ name }) => names.has(name)));
export const fake = (await getAdapter(linkedinPort, "fake")) as unknown as LinkedinFake;
const files = await getAdapter(filesPort, "fake");
/** Every start the plan asks for, recorded; none runs. */
export const starts: WorkflowStart[] = [];
let offset = 0;
let creditsOffset = 0;
let workflowId = "";

/** The time campaigns and linkedin read. */
export const now = (): Date => new Date(Date.now() + offset);
/** Both clocks moved by `ms`. */
export const skip = (ms: number): void => void (offset += ms);
/** A time for the `n`th step after a send: a gap after it, and a margin for the send itself. */
export const afterSend = (n = 1): Date =>
  new Date(now().getTime() + n * (MIN_ACTION_GAP_MS + 5000));
/** Credits' clock past every lease: a commit after it answers usage_not_open. */
export const leasesEnd = (): void => void (creditsOffset = 2 * DAY_MS);
export const sends = () => fake.recordedCalls.filter(({ method }) => SEND_METHODS.has(method));
/** The workflow `id` terminated, as a worker killed with it would leave it (beta-p4-040). */
export const terminate = async (id: string): Promise<void> => {
  await env.client.workflow.getHandle(id).terminate("test");
};

/** The file's schema, Temporal, the modules started and the hooks, once at its top. */
export function useSenderTests(): void {
  withTestDb();
  app = asRole("app");
  env = withTestWorkflowEnvironment();
  useHashSalt("test-salt-".repeat(4));
  credits.useCreditsClient(app);
  linkedin.useLinkedinClient(app);
  tenancy.useTenancyClient(app);
  linkedin.useSecretKeys(platform.loadMasterKeys({ APP_MASTER_KEY: platform.newMasterKey() }));
  campaigns.useClock(now);
  linkedin.useClock(now);
  before(async () => {
    await startModules(loaded, log);
    // After credits' own: the client on credits' clock, which leasesEnd moves.
    const creditsNow = () => new Date(Date.now() + creditsOffset);
    platform.bindCreditsClient(credits.createCreditsClient(creditsNow));
    platform.bindWorkflowStarter({
      start: async (request) => {
        starts.push(request);
        return { started: true };
      },
    });
  });
  beforeEach(() => {
    fake.reset();
    offset = THURSDAY.getTime() - Date.now();
    creditsOffset = 0;
    starts.length = 0;
  });
}

/** A wait longer than WAIT_RUN_MS answered again with the clocks moved to WAIT_RUN_MS before its end. */
const skipWaits: Wrap = (run) => async (input, context) => {
  workflowId = context.workflowId;
  const answer = (await run(input, context)) as { step: { waitMs: number } | null };
  const waitMs = answer.step?.waitMs ?? 0;
  if (waitMs <= WAIT_RUN_MS) return answer;
  skip(waitMs - WAIT_RUN_MS);
  return run(input, context);
};

/** The loaded activities through the host's wrapper, `wrap`'s replacing their runs. */
function activities(wrap: Record<string, Wrap>) {
  const wraps: Record<string, Wrap> = { ...wrap };
  const next = wraps.campaigns_sender_next;
  wraps.campaigns_sender_next = (run) => skipWaits(next?.(run) ?? run);
  return Object.fromEntries(
    [...loaded.activities].map(([name, definition]) => {
      const run = wraps[name]?.(definition.run as Run) ?? definition.run;
      return [name, hostActivity(name, { ...definition, run }, { client: app, log })];
    }),
  );
}

/** `fn` once, after the activity's first run and before its answer reaches the workflow. */
export function thenOnce(fn: (input: never) => Promise<unknown> | void): Wrap {
  let done = false;
  return (run) => async (input, context) => {
    const answer = await run(input, context);
    if (!done) {
      done = true;
      await fn(input);
    }
    return answer;
  };
}

/** The send activity's first attempt killed once the fake recorded its call; its retries run. */
export const killedAfterSend: Wrap = (run) => (input, context) => {
  if (context.attempt > 1) return run(input, context);
  const before = sends().length;
  const tenant: Tenant = (fn) =>
    sends().length > before ? Promise.reject(new Error("killed")) : context.tenant(fn);
  return run(input, { ...context, tenant });
};

/**
 * The price list as the api's start writes it: campaigns' prices declared in a process whose
 * environment has `variables` too, with the PRICE_ overrides of `variables`.
 */
export async function writePrices(variables: Record<string, string>): Promise<void> {
  const script = [
    'const { registeredPrices } = await import("@whytide/platform");',
    `await import(${JSON.stringify(prices)});`,
    "process.stdout.write(JSON.stringify([...registeredPrices().values()]));",
  ].join("\n");
  const declared = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: import.meta.dirname,
    env: { APP_ENV: "test", ...variables },
    encoding: "utf8",
  });
  assert.equal(declared.status, 0, declared.stderr);
  const list = assemblePrices(JSON.parse(declared.stdout), variables);
  await syncPrices(asRole("billing_writer"), list, log);
}

export type Sender = Awaited<ReturnType<typeof sender>>;

/**
 * A workspace with `allowance` credits at the prices `variables` set, its owner's connected account
 * the fake knows, sending open, and its leads, steps and runs.
 */
export async function sender(allowance = 100, variables: Record<string, string> = {}) {
  await writePrices(variables);
  const [{ organization, workspace }] = await tenancy.createTwoWorkspaces();
  const workspaceId: string = workspace.id;
  await credits.grantAllowance([organization.id], allowance);
  const ref = `fake-account-${randomUUID()}`;
  fake.emitWebhook("account.connected", ref);
  const options = { ownerUserId: OWNER, providerAccountRef: ref, workingHours: ALWAYS };
  const { id: accountId } = await linkedin.createConnectedAccount(workspaceId, options);
  // The highest targets: room for a test's steps in the day's limits.
  const targets = { inviteTarget: 15, messageTarget: 40 };
  await app.senderAccount.update({ where: { id: accountId }, data: targets });
  await linkedin.openSending();
  const run: Tenant = (fn) => withTenant({ workspaceId, principal }, fn, { client: app });

  /** A person with a member ref, their lead in the campaign, enrolled 3 days ago: steps by key. */
  async function lead(slug: string) {
    const memberRef = `member-${randomUUID()}`;
    const linkedinUrl = `https://linkedin.com/in/${slug}-${randomUUID().slice(0, 8)}`;
    const personId: string = await run(async () => {
      const profile = { linkedinUrl, providerId: memberRef, firstName: "Noor" };
      const source = { source: "linkedin", provider: "unipile", profile };
      const { person } = await contacts.upsertPersonFromSource(source);
      await contacts.createLeadForPerson({
        personId: person.id,
        source: { kind: "imported", ref: "imp_1" },
      });
      await contacts.recordLeadStatus(person.id, "approved", {
        actor: { type: "user", id: OWNER },
      });
      const campaign = { templateId: "linkedin_default", actor: { type: "system" } };
      await contacts.recordLeadStatus(person.id, "in_campaign", campaign);
      return person.id;
    });
    const startedAt = new Date(now().getTime() - 3 * DAY_MS);
    const enrollment = {
      id: platform.newId(ids.enrollment),
      ...{ workspaceId, personId, senderAccountId: accountId },
    };
    await app.enrollment.create({
      data: {
        ...{ ...enrollment, templateId: "linkedin_default", templateVersion: 1 },
        ...{ status: "active", sourceEventId: platform.newId("obx"), startedAt },
      },
    });
    const rows = plannedSteps(enrollment, startedAt);
    await app.stepExecution.createMany({ data: rows });
    const steps: Record<string, string> = Object.fromEntries(
      rows.map(({ id, stepKey }: { id: string; stepKey: string }) => [stepKey, id]),
    );
    return { personId, memberRef, enrollmentId: enrollment.id, steps };
  }

  /** The step approved by the owner with `text` (a connection request's note), `scheduled`. */
  async function approve(id: string, approved: string): Promise<void> {
    const step = await app.stepExecution.findUniqueOrThrow({ where: { id } });
    const { personId, stepKey } = step;
    const draft = { workspaceId, personId, stepExecutionId: id, stepKey, status: "approved" };
    const draftId = await createStepDraft({ ...draft, text: approved });
    const approvalItemId = await createApprovalItem({
      ...{ workspaceId, personId, senderAccountId: accountId, stepExecutionId: id, stepKey },
      ...{ status: "approved", draftId, approvedContentHash: sha256(approved), decidedBy: OWNER },
    });
    const dueAt = step.dueAt ?? new Date(now().getTime() - DAY_MS);
    const data = { status: "scheduled", approvalItemId, draftId, dueAt } as const;
    await app.stepExecution.update({ where: { id }, data });
  }

  /** The step placed at `at` on its day in UTC, the account's zone, as the plan places it. */
  async function place(id: string, at = now()): Promise<Date> {
    const data = { scheduledFor: at, quotaDay: at.toISOString().slice(0, 10) };
    await app.stepExecution.update({ where: { id }, data });
    return at;
  }

  /**
   * A new lead's step `key` approved with `approved` and placed at `at`; a message's earlier steps
   * sent two days ago, its person a relation of the account's.
   */
  async function ready(slug: string, key = "connect", approved = "", at = now()) {
    const enrolled = await lead(slug);
    const id = enrolled.steps[key] as string;
    if (key !== "connect") {
      const { position } = await app.stepExecution.findUniqueOrThrow({ where: { id } });
      await app.stepExecution.updateMany({
        where: { enrollmentId: enrolled.enrollmentId, position: { lt: position } },
        data: { status: "succeeded", executedAt: new Date(now().getTime() - 2 * DAY_MS) },
      });
      fake.seedRelation(ref, enrolled.memberRef);
    }
    await approve(id, approved);
    await place(id, at);
    return { ...enrolled, id };
  }

  /** The sender's run to its end, `wrap` replacing activities' runs; its result and workflow id. */
  async function send(wrap: Record<string, Wrap> = {}) {
    const input = { workspaceId, accountId };
    const result = await runWorkflow<SenderRun>("campaigns_sender", input, {
      activities: activities(wrap),
    });
    return { result, workflowId };
  }

  return {
    ...{ workspaceId, organizationId: organization.id as string, accountId, ref, run },
    ...{ lead, approve, place, ready, send },
    plan: () => runWorkflow("campaigns_plan", { workspaceId }, { activities: activities({}) }),
    /** Activity `name` called directly, in a context of the test's. */
    call(name: string, input: object, tenant: Tenant = run): Promise<unknown> {
      const definition = loaded.activities.get(name);
      assert.ok(definition, name);
      const context: Context = { workspaceId, workflowId: "test", attempt: 1, tenant };
      return definition.run(definition.input.parse(input), context);
    },
    /** The step's request file, if any, with `change` merged in, written back. */
    async rewriteRequest(id: string, change: Record<string, unknown>): Promise<void> {
      const key = `raw/campaigns/${id}/send.json`;
      const body = JSON.parse(await text((await files.get({ workspaceId, key })).body));
      const put = { workspaceId, key, contentType: "application/json" };
      await files.put({ ...put, body: JSON.stringify({ ...body, ...change }) });
    },
    /** The usage released, as a recovery frees a step's credits. */
    releaseUsage: (usageId: string) => run(() => platform.credits.release(usageId)),
    /** The step's request file deleted, as a step whose file was never written (beta-p4-040). */
    async dropRequest(id: string): Promise<void> {
      await files.delete({ workspaceId, key: `raw/campaigns/${id}/send.json` });
    },
    /** Whether the step's request file is still under raw/. */
    async hasRequest(id: string): Promise<boolean> {
      const key = `raw/campaigns/${id}/send.json`;
      return files.get({ workspaceId, key }).then(
        () => true,
        () => false,
      );
    },
  };
}

/** A step as the tests read it. */
export type StepRow = {
  readonly status: string;
  readonly attempt: number;
  readonly dueAt: Date | null;
  readonly scheduledFor: Date | null;
  readonly executedAt: Date | null;
  readonly errorCode: string | null;
  readonly skipReason: string | null;
  readonly jitChecks: unknown;
  readonly approvalItemId: string | null;
  readonly draftId: string | null;
  readonly creditUsageId: string | null;
  readonly idempotencyKey: string;
};
export const stepOf = (id: string): Promise<StepRow> =>
  app.stepExecution.findUniqueOrThrow({ where: { id } });

/** The step's credit usages, as `:<attempt> <status> <credits>`, by key. */
export async function usagesOf(id: string): Promise<string[]> {
  const rows = await app.creditUsage.findMany({ where: { subjectRef: id } });
  return rows
    .map(
      (row) =>
        `${row.idempotencyKey.slice(row.idempotencyKey.lastIndexOf(":"))} ${row.status} ${row.credits.toFixed()}`,
    )
    .sort();
}

/** The statuses of linkedin's reservations under the step's key. */
export async function slotsOf(id: string): Promise<string[]> {
  const { idempotencyKey } = await stepOf(id);
  const rows = await app.senderQuotaReservation.findMany({ where: { idempotencyKey } });
  return rows.map(({ status }) => status).sort();
}

/** linkedin's action log rows of the step's sends, as `kind:outcome`, sorted. */
export async function rowsOf(id: string): Promise<string[]> {
  const select = { kind: true, outcome: true } as const;
  const rows = await app.senderActionLog.findMany({ where: { objectRef: id }, select });
  return rows.map(({ kind, outcome }) => `${kind}:${outcome}`).sort();
}

/** A run's history decoded: the events as JSON, then each payload's text. */
export async function historyOf(id: string): Promise<string> {
  const history = await env.client.workflow.getHandle(id).fetchHistory();
  const decoded: string[] = [];
  const raw = JSON.stringify(JSON.parse(historyToJSON(history)), (_key, value) => {
    const data = (value as { metadata?: unknown; data?: unknown } | null)?.data;
    if (typeof data === "string" && (value as { metadata?: unknown }).metadata) {
      decoded.push(Buffer.from(data, "base64").toString("utf8"));
    }
    return value;
  });
  return [raw, ...decoded].join("\n");
}

/** Workflow `name` run to its end on `input`, the loaded activities through the host's wrapper. */
export const runLoaded = <T>(name: string, input: object): Promise<T> =>
  runWorkflow<T>(name, input, { activities: activities({}) });

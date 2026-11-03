// messaging's draft workflow end to end (alpha-p9-020; core/modules/messaging/README.md "The
// workflow"), on the slice's Temporal, a schema of its database and the LLM fake: messaging loaded
// from its build by the worker's own loader, its activities through the host's wrapper, its writer
// calling the model as the test's app role; a member's draft, its edit and its regeneration, the
// writer's failure mark; last, the worker host itself, from the draft's event in the outbox. The
// lead is written by contacts' commands, the member by tenancy's factories, from their builds. The
// replay of the recorded history is `pnpm -F worker test:replay`.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { TenantClient } from "@whytide/db";
import type { ActivityContext, ActivityDefinition, Principal } from "@whytide/platform";
import type { LlmFake } from "@whytide/providers";
import type { ModuleLoader } from "../src/modules.ts";

// The LLM fake whatever the environment names: the providers' config reads it as it loads, below.
process.env.PROVIDER_LLM = "fake";

const { aiErrors, loadAgentTasks } = await import("@whytide/ai");
const { outboxWriter, withTenant } = await import("@whytide/db");
const { asRole, withTestDb } = await import("@whytide/db/testing");
const platform = await import("@whytide/platform");
const { getAdapter, llmPort } = await import("@whytide/providers");
const { hostActivity } = await import("../src/activities.ts");
const { moduleLoaders } = await import("../src/modules.generated.ts");
const { loadModules } = await import("../src/modules.ts");
const { start } = await import("../src/start.ts");
const { runWorkflow, withTestWorkflowEnvironment } = await import("../testing/index.ts");
const built = (file: string) => new URL(`../../../modules/${file}`, import.meta.url).href;
const { createLeadForPerson, upsertPersonFromSource } = await import(
  built("contacts/dist/index.js")
);
const { useHashSalt } = await import(built("contacts/dist/testing/index.js"));
const { events } = await import(built("messaging/dist/events.js"));
const { editDraft, regenerateDraft, requestDraft } = await import(
  built("messaging/dist/domain/drafts/store.js")
);
const { useMessagingClient } = await import(built("messaging/dist/testing/index.js"));
const tenancy = await import(built("tenancy/dist/testing/index.js"));

withTestDb();
const env = withTestWorkflowEnvironment();
const app = () => asRole("app");
useHashSalt("test-salt-".repeat(4));
useMessagingClient(app());
tenancy.useTenancyClient(app());
await loadAgentTasks();
const fake = (await getAdapter(llmPort, "fake")) as unknown as LlmFake;
beforeEach(() => fake.reset());
const log = platform.createLogger({ destination: platform.collectLogs().destination });
const prices = {
  version: "test",
  prices: { fake: { "fake-model": { input_tokens: 0, output_tokens: 0 } } },
};

/** The writer's activity with callAgent's options: the test's schema and the fake's price. */
function withCall(definition: ActivityDefinition): ActivityDefinition {
  if (definition.scope === "global") return definition;
  const { run } = definition;
  return {
    ...definition,
    run: (input, context: ActivityContext) => {
      // What writeDraft reads besides the context (domain/drafts/write.ts, DraftContext).
      const withCall = { ...context, call: { client: app(), prices } };
      return run(input, withCall);
    },
  };
}
/** messaging as the worker's loader loads it from its build, its writer calling as above. */
const messaging: ModuleLoader[] = moduleLoaders
  .filter(({ name }) => name === "messaging")
  .map((loader) => ({
    ...loader,
    workflows: async () => {
      const declared = (await loader.workflows?.()) as {
        readonly activities: Record<string, ActivityDefinition>;
      };
      const activities = Object.fromEntries(
        Object.entries(declared.activities).map(([name, definition]) => [
          name,
          name === "messaging_write_draft" ? withCall(definition) : definition,
        ]),
      );
      return { ...declared, activities };
    },
  }));
const loaded = await loadModules(messaging);
const activities = Object.fromEntries(
  [...loaded.activities].map(([name, definition]) => {
    return [name, hostActivity(name, definition, { client: app(), log })];
  }),
);

type Seeded = { workspaceId: string; personId: string; userId: string };
type Row = { readonly id: string };
/** A workspace with a Member, and a lead with nothing but its profile: f_2 is its first name. */
async function seed(): Promise<Seeded> {
  const { workspace } = await tenancy.createOrganizationWithWorkspace();
  const user = await tenancy.createUser();
  await tenancy.createMembership({ userId: user.id, workspaceId: workspace.id, role: "Member" });
  const workspaceId: string = workspace.id;
  const principal = platform.servicePrincipal("test");
  const personId = await withTenant(
    { workspaceId, principal },
    async () => {
      const profile = {
        linkedinUrl: `https://linkedin.com/in/ines-${randomUUID()}`,
        firstName: "Ines",
        lastName: "Duarte",
        headline: "Head of Data",
        title: "Head of Data",
        locationText: "Lisbon, Portugal",
      };
      const source = { source: "linkedin", provider: null, profile };
      const { person } = await upsertPersonFromSource(source);
      await createLeadForPerson({ personId: person.id, source: { kind: "signal", ref: "sev_1" } });
      return person.id as string;
    },
    { client: app() },
  );
  return { workspaceId, personId, userId: user.id };
}
/** A run of the member's request, as the route's tenant run is. */
function asMember<T>({ workspaceId, userId }: Seeded, fn: (tx: TenantClient) => Promise<T>) {
  const principal: Principal = {
    ...{ userId, actorType: "human", authMethod: "session", workspaceId, role: "Member" },
    scopes: [],
  };
  return withTenant({ workspaceId, principal }, fn, { client: app() });
}
const rowOf = (id: string) => app().messageDraft.findUniqueOrThrow({ where: { id } });
const draft = (input: object) =>
  runWorkflow<{ status: string }>("messaging_draft_message", input, { activities });
type Recorded = { messages: { content: { text: string }[] }[] };
/** A block of the recorded call's user message, parsed. */
function blockOf(index: number, name: string): unknown {
  const { messages } = fake.recordedCalls[index]?.input as Recorded;
  const text = messages.flatMap((message) => message.content.map((part) => part.text)).join("");
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text);
  return JSON.parse(found?.[1] ?? "undefined");
}
/** The code of the activity failure that failed a workflow. */
const codeOf = (error: unknown) =>
  (error as { cause?: { cause?: { type?: string } } }).cause?.cause?.type;
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    assert.ok(Date.now() < deadline, "until: nothing within thirty seconds");
    await sleep(50);
  }
}

const PLAN = { angle: "pain_point", factIds: ["f_2"], cta: "question" };
const NOTE = "Ines, how does your team follow up on warm leads today?";
const OWN = "Ines, a short question about your data team, if you have a minute.";
const AGAIN = "Ines, what slows your team down when warm leads go cold?";

test("the workflow writes a member's draft; criterion 5: an edit makes it edited, and its regeneration is a new row, written with it in <replaced>, while the edited row is unchanged", async () => {
  const seeded = await seed();
  const { workspaceId, personId, userId } = seeded;
  const first = await asMember<Row>(seeded, () =>
    requestDraft({ personId, channel: "linkedin_note" }),
  );
  fake.script(PLAN, { text: NOTE });
  const input = { workspaceId, draftId: first.id, personId, userId };
  assert.deepEqual(await draft(input), { status: "ready" });
  const written = await rowOf(first.id);
  assert.deepEqual([written.status, written.text, written.flagReasons], ["ready", NOTE, []]);

  await asMember(seeded, () => editDraft(first.id, { editedText: OWN }));
  const edited = await rowOf(first.id);
  assert.deepEqual([edited.status, edited.text, edited.editedText], ["edited", NOTE, OWN]);
  const second = await asMember<Row>(seeded, () => regenerateDraft(first.id));
  fake.reset();
  fake.script({ ...PLAN, cta: "soft_ask" }, { text: AGAIN });
  const regenerated = await draft({ ...input, draftId: second.id, replacesId: first.id });
  assert.deepEqual(regenerated, { status: "ready" });
  const replaced = { angle: "pain_point", cta: "question", text: OWN };
  assert.deepEqual([blockOf(0, "replaced"), blockOf(1, "replaced")], [replaced, replaced]);
  const again = await rowOf(second.id);
  assert.deepEqual(
    [again.personId, again.channel, again.status, again.text],
    [personId, "linkedin_note", "ready", AGAIN],
  );
  assert.deepEqual(await rowOf(first.id), edited, "the edited row, unchanged");
  assert.deepEqual(await draft(input), { status: "edited" }, "a run again writes nothing");
  assert.deepEqual(await rowOf(first.id), edited);
});

test("a writer that failed past its attempts marks the draft failed, write_failed, and fails the workflow", async () => {
  const seeded = await seed();
  const { workspaceId, personId, userId } = seeded;
  const { id } = await asMember<Row>(seeded, () =>
    requestDraft({ personId, channel: "linkedin_note" }),
  );
  const definition = loaded.activities.get("messaging_write_draft");
  if (definition === undefined) throw new Error("messaging_write_draft is not loaded");
  const run = async () => {
    throw new platform.AppError(aiErrors.ai_budget_exceeded);
  };
  const failing = hostActivity(
    "messaging_write_draft",
    { ...definition, run },
    { client: app(), log },
  );
  const input = { workspaceId, draftId: id, personId, userId };
  await assert.rejects(
    runWorkflow("messaging_draft_message", input, {
      activities: { ...activities, messaging_write_draft: failing },
    }),
    (error) => codeOf(error) === "ai_budget_exceeded",
  );
  const failed = await rowOf(id);
  assert.deepEqual([failed.status, failed.flagReasons], ["failed", [{ code: "write_failed" }]]);
});

test("through the host: messaging.draft_requested starts one run by messaging.draft:<workspace>:<draft>, which writes the draft; a second delivery starts none", async () => {
  const taskQueue = `test-${randomUUID()}`;
  const host = await start({ modules: messaging, taskQueue, healthPort: 0, client: app(), log });
  try {
    const seeded = await seed();
    const { workspaceId, personId, userId } = seeded;
    fake.script(PLAN, { text: NOTE });
    const { id } = await asMember<Row>(seeded, () =>
      requestDraft({ personId, channel: "linkedin_note" }),
    );
    const ended = await until(async () => {
      const row = await rowOf(id);
      return row.status === "drafting" ? undefined : row;
    });
    assert.deepEqual([ended.status, ended.text], ["ready", NOTE]);
    const run = env.client.workflow.getHandle(`messaging.draft:${workspaceId}:${id}`);
    assert.deepEqual(await run.result(), { status: "ready" });
    const { runId } = await run.describe();
    const payload = { workspaceId, draftId: id, personId, userId };
    const name = events["messaging.draft_requested"];
    const again = await asMember(seeded, (tx) =>
      platform.publish(outboxWriter(tx, workspaceId), name, payload),
    );
    const delivered = await until(async () => {
      const row = await app().outboxEntry.findUniqueOrThrow({ where: { id: again } });
      return row.deliveredAt === null && row.lastError === null ? undefined : row;
    });
    assert.deepEqual([delivered.lastError, (await run.describe()).runId], [null, runId]);
  } finally {
    await host.close();
  }
});

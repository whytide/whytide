// writeReply as inbox's reply draft activity calls it (domain/replies/write.ts; inbox-reply-draft):
// outside any run, on the LLM fake, against the worktree's database, on the drafts' fixture lead. The
// conversation the writer reads (the latest REPLY_CHAT_MAX within the bytes' bound, oldest first), its
// blocks as data, the brief and the conversation grounding a reply, one rewrite with <failures>, then
// gates_failed; a new request's id a new model call; another language's reply checked for its numbers
// and dates, not its names. The workflow and the routes are the worker's and the api host's tests.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { DATA_SENTENCE, loadAgentTasks } from "@whytide/ai";
import { asRole, withTestDb } from "@whytide/db/testing";
import { useTenancyClient } from "@whytide/tenancy/testing";
import { textLanguage } from "../domain/drafts/language.ts";
import { type ChatMessage, replyChat } from "../domain/replies/chat.ts";
import { REPLY_CHAT_BYTES_MAX, REPLY_CHAT_MAX } from "../domain/replies/constants.ts";
import { writeReply } from "../domain/replies/write.ts";
import { WRITE_REPLY } from "../schemas/reply.ts";
import { useMessagingClient } from "../testing/index.ts";
import { contextOf, fake, run, seed } from "./fixtures/draft.ts";

withTestDb();
useTenancyClient(asRole("app"));
useMessagingClient(asRole("app"));
await loadAgentTasks([new URL("../agents/write-reply/task.ts", import.meta.url).href]);
beforeEach(() => fake.reset());

const at = (minute: number) => new Date(Date.UTC(2026, 10, 3, 9, minute));
const lead = (text: string, minute = 1): ChatMessage => ({ from: "lead", at: at(minute), text });
const CHAT = [
  { from: "seller", at: at(0), text: "Ines, how does your data team follow up on warm leads?" },
  lead("Good question. Can Signal Radar show us which leads went cold last month?"),
] as const;
const BRIEF = "Say yes and offer a 20 minute call on Tuesday or Thursday.";
const READY =
  "Ines, yes: Signal Radar shows which leads went cold and when. Would a 20 minute call on Tuesday or Thursday suit you?";

type Recorded = { system: string; messages: { content: { text: string }[] }[] };
/** A block of the recorded call's user message, parsed as JSON, or as it is for a string. */
function blockOf(index: number, name: string): unknown {
  const { messages } = fake.recordedCalls[index]?.input as Recorded;
  const text = messages.flatMap((message) => message.content.map((part) => part.text)).join("");
  const found = new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(text)?.[1];
  try {
    return JSON.parse(found ?? "undefined");
  } catch {
    return found;
  }
}

test("the conversation the writer reads: the latest REPLY_CHAT_MAX, oldest first, empty texts left out, the oldest dropped first past the bytes' bound, the latest kept", () => {
  const many = Array.from({ length: 25 }, (_, minute) => lead(`message ${minute}`, minute));
  const chat = replyChat([...many, lead("  ", 30)]);
  assert.equal(chat.length, REPLY_CHAT_MAX);
  assert.deepEqual(
    [chat[0]?.text, chat.at(-1)?.text, chat.at(-1)?.at],
    ["message 5", "message 24", at(24).toISOString()],
  );
  const long = Array.from({ length: 20 }, (_, minute) => lead("é".repeat(2_000), minute));
  const kept = replyChat(long);
  const bytes = kept.reduce((sum, { text }) => sum + new TextEncoder().encode(text).length, 0);
  assert.ok(bytes <= REPLY_CHAT_BYTES_MAX && kept.length === 6, `${kept.length} kept`);
  assert.equal(kept.at(-1)?.at, at(19).toISOString());
});

test("a ready reply: the conversation and the brief reach the model as data blocks, the brief's call times ground it, with a decision record and a cost event on the person", async () => {
  const { workspaceId, personId, userId } = await seed();
  fake.script({ text: READY });
  const request = {
    personId,
    userId,
    conversation: [...CHAT],
    brief: ` ${BRIEF} `,
    replaced: null,
    requestId: "rdr_ready",
  };
  const written = await writeReply(request, contextOf(workspaceId));
  const records = await run(workspaceId, (tx) => tx.decisionRecord.findMany());
  assert.deepEqual(written, {
    ...{ status: "ready", text: READY, modelId: "fake-model", promptVersion: 2 },
    decisionRecordId: records[0]?.id,
  });
  assert.deepEqual(
    records.map(({ task, subjectRef }) => [task, subjectRef]),
    [[WRITE_REPLY, personId]],
  );
  const { system } = fake.recordedCalls[0]?.input as Recorded;
  const header = "Data blocks: <channel>, <dossier>, <lead>, <why_now>, <conversation>, <brief>";
  assert.ok(system.startsWith(`${header}, <failures>, <replaced>, <request>\n${DATA_SENTENCE}\n`));
  assert.deepEqual(blockOf(0, "conversation"), replyChat([...CHAT]));
  assert.equal(blockOf(0, "request"), "rdr_ready");
  assert.deepEqual(blockOf(0, "channel"), {
    ...{ channel: "linkedin_message", maxCharacters: 1_900, language: "english" },
  });
  assert.deepEqual([blockOf(0, "brief"), blockOf(0, "failures")], [BRIEF, []]);
  assert.deepEqual((blockOf(0, "lead") as { firstName: object }).firstName, { f_7: "Ines" });
  const costs = await run(workspaceId, (tx) => tx.costEvent.findMany());
  assert.deepEqual(
    costs.map(({ task, subjectRef }) => [task, subjectRef]),
    [[WRITE_REPLY, personId]],
  );
});

test("an answer the gates refuse is written again once with its issues in <failures>; a second refusal fails the reply gates_failed", async () => {
  const { workspaceId, personId, userId } = await seed();
  const invented =
    "Ines, Globex saw 3 times more replies with Signal Radar. Would you like to see it?";
  const issues = [
    { gate: "grounding", entity: "3" },
    { gate: "grounding", entity: "Globex" },
  ];
  const request = {
    ...{ personId, userId, conversation: [...CHAT], brief: null, replaced: null },
    requestId: "rdr_first",
  };
  fake.script(
    { text: invented },
    { text: "Ines, yes: Signal Radar shows the leads that went cold." },
  );
  const ready = await writeReply(request, contextOf(workspaceId));
  assert.equal(ready.status, "ready");
  assert.deepEqual([blockOf(0, "failures"), blockOf(1, "failures")], [[], [issues]]);
  assert.deepEqual(blockOf(1, "brief"), null);

  fake.reset();
  fake.script({ text: invented }, { text: `${invented} [calendar link]` });
  const failed = await writeReply(
    { ...request, replaced: "An earlier draft." },
    contextOf(workspaceId),
  );
  assert.deepEqual(
    [failed.status, failed.status === "failed" && failed.code],
    ["failed", "gates_failed"],
  );
  assert.equal(blockOf(0, "replaced"), "An earlier draft.");
});

test("Try again: the same request's id is answered from the cache with no call, a new request's id asks the model again", async () => {
  const { workspaceId, personId, userId } = await seed();
  const invented = "Ines, Globex saw 3 times more replies. Would you like to see it?";
  const request = {
    ...{ personId, userId, conversation: [...CHAT], brief: null, replaced: null },
    requestId: "rdr_failed",
  };
  fake.script({ text: invented }, { text: `${invented} [calendar link]` });
  const failed = await writeReply(request, contextOf(workspaceId));
  assert.deepEqual([failed.status, fake.recordedCalls.length], ["failed", 2]);

  // An activity's retry of the same draft: callAgent's cache, no call paid twice.
  const retried = await writeReply(request, contextOf(workspaceId));
  assert.deepEqual([retried.status, fake.recordedCalls.length], ["failed", 2]);

  // Try again is a new draft, a new id: the model is asked again.
  fake.script({ text: "Ines, yes: Signal Radar shows the leads that went cold." });
  const again = await writeReply({ ...request, requestId: "rdr_again" }, contextOf(workspaceId));
  assert.deepEqual([again.status, fake.recordedCalls.length], ["ready", 3]);
  assert.equal(blockOf(2, "request"), "rdr_again");
});

test("a Spanish conversation: the language is the lead's, and the reply's capitals pass while an invented number fails; no message, conversation_empty with no call", async () => {
  const { workspaceId, personId, userId } = await seed();
  const spanish = lead(
    "Hola, nuestro equipo de ventas tambien quiere saber el precio para las licencias.",
  );
  assert.equal(textLanguage([spanish.text]), "spanish");
  const request = {
    ...{ personId, userId, conversation: [spanish], brief: null, replaced: null },
    requestId: "rdr_spanish",
  };
  const answer = "Hola Ines, Gracias por tu mensaje. Te enviaré el Precio exacto muy pronto.";
  fake.script({ text: `${answer} Son 400 euros.` }, { text: answer });
  const written = await writeReply(request, contextOf(workspaceId));
  assert.deepEqual(
    [written.status, (blockOf(0, "channel") as { language: string }).language],
    ["ready", "spanish"],
  );
  assert.deepEqual(blockOf(1, "failures"), [[{ gate: "grounding", entity: "400" }]]);

  fake.reset();
  const empty = await writeReply({ ...request, conversation: [lead(" ")] }, contextOf(workspaceId));
  assert.deepEqual(empty, { status: "failed", code: "conversation_empty", decisionRecordId: null });
  assert.equal(fake.recordedCalls.length, 0);
});

test("a Spanish reply's dates are checked as in English: an invented date fails grounding, a date of the brief passes", async () => {
  const { workspaceId, personId, userId } = await seed();
  const spanish = lead(
    "Hola, nos interesa mucho. ¿Podemos hablar de las licencias para el equipo de ventas la semana que viene?",
  );
  assert.equal(textLanguage([spanish.text]), "spanish");
  const request = {
    ...{ personId, userId, conversation: [spanish], replaced: null },
    ...{ brief: "Offer a call on 2026-11-12.", requestId: "rdr_dates" },
  };
  const answer = (day: string) => `Hola Ines, Claro que sí. ¿Te viene bien una llamada el ${day}?`;
  fake.script({ text: answer("2026-11-19") }, { text: answer("2026-11-12") });
  const written = await writeReply(request, contextOf(workspaceId));
  assert.deepEqual(
    [written.status, written.status === "ready" && written.text],
    ["ready", answer("2026-11-12")],
  );
  assert.deepEqual(blockOf(1, "failures"), [[{ gate: "grounding", entity: "2026-11-19" }]]);
});

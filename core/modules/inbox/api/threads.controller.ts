// The inbox's routes (README.md "API"), which the api host mounts under
// /v1/workspaces/:workspaceId/inbox: thin handlers over domain/threads/ and domain/labels/, inside the
// request's tenant run. They read and write inbox's tables, contacts' getLead and the reply state's
// reads of linkedin's account and contacts' person aside; the label locks the person's lead and runs
// campaigns' default action of the thread owner's label (gamma-p4-055). None calls a provider or a
// model: nothing here sends (the reply's route is replies.controller.ts). A module cannot import the
// host, so each route sets the host's metadata itself: its permission and its @ApiRoute. The label's
// PUT sets a state, so a repeat changes nothing: it takes no Idempotency-Key.
import { Body, Controller, Get, Param, Put, Query, SetMetadata } from "@nestjs/common";
import { currentTenant } from "@whytide/platform";
import { setLabel } from "../domain/labels/label.ts";
import { decodeCursor } from "../domain/threads/cursor.ts";
import {
  type LabelState,
  listThreads,
  readThread,
  type ThreadSummary,
} from "../domain/threads/queries.ts";
import { errors } from "../errors.ts";
import { permissions } from "../permissions.ts";
import {
  idParams,
  type LabelBody,
  type LabelResponse,
  labelBody,
  labelResponse,
  type MessageLabel,
  type ThreadPage,
  type ThreadResponse,
  type ThreadSummaryResponse,
  type ThreadsQuery,
  threadPage,
  threadResponse,
  threadsQuery,
} from "../schemas/threads.ts";

const canRead = SetMetadata("whytide:permission", permissions["inbox.read"]);
const canLabel = SetMetadata("whytide:permission", permissions["inbox.label"]);
const route = (spec: Record<string, unknown>) => SetMetadata("whytide:api-route", spec);

@Controller()
export class ThreadsController {
  @Get("threads")
  @canRead
  @route({
    summary:
      "The workspace's threads, the conversations the platform started, newest first, a page at a time: each with its lead, who wrote last and how many replies wait for a label",
    query: threadsQuery,
    response: threadPage,
  })
  async threads(@Query() query: ThreadsQuery): Promise<ThreadPage> {
    // The query's schema let through only a cursor this list wrote.
    const after =
      query.cursor === undefined ? undefined : (decodeCursor(query.cursor) ?? undefined);
    const { threads, nextCursor } = await listThreads({ limit: query.limit, after });
    return { threads: threads.map(toSummary), nextCursor };
  }

  @Get("threads/:id")
  @canRead
  @route({
    summary:
      "A thread with its lead and its messages, oldest first, each reply with its label and each reply from the inbox with its send's status; and whether the caller replies on it",
    params: idParams,
    response: threadResponse,
    errors: [errors.thread_not_found],
  })
  async thread(@Param("id") id: string): Promise<ThreadResponse> {
    const { messages, reply, ...thread } = await readThread(id);
    return {
      ...toSummary(thread),
      reply,
      messages: messages.map((message) => ({
        ...message,
        sentAt: message.sentAt.toISOString(),
        approvedAt: message.approvedAt?.toISOString() ?? null,
        label: message.label && toLabel(message.label),
      })),
    };
  }

  @Put("messages/:id/label")
  @canLabel
  @route({
    summary:
      "Labels a reply of the caller's own thread with one of the 7 labels, confirming the classifier's suggestion or changing it, and runs that label's default action when it is the person's newest reply; the label it holds already changes nothing",
    params: idParams,
    body: labelBody,
    response: labelResponse,
    errors: [errors.inbox_message_not_found, errors.message_not_inbound],
  })
  async label(@Param("id") id: string, @Body() body: LabelBody): Promise<LabelResponse> {
    const chosen = await setLabel(id, body.label, currentTenant().principal.userId);
    return { ...chosen, labeledAt: chosen.labeledAt.toISOString() };
  }
}

function toSummary(thread: ThreadSummary): ThreadSummaryResponse {
  return { ...thread, lastMessageAt: thread.lastMessageAt.toISOString() };
}

function toLabel(state: LabelState): MessageLabel {
  return { ...state, labeledAt: state.labeledAt.toISOString() };
}

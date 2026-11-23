// The reply box under a thread (thread.tsx; README.md "Replies from the inbox"), on the caller's own
// thread whose channel sends now only: the text, with the ui's counter of the most the thread's
// channel takes, and Send, disabled while the text is empty. Send sends POST
// …/inbox/threads/{id}/replies with the text and an Idempotency-Key; while it runs, another press
// sends nothing. Then the box empties and the thread is read again, its new message Sending. The box
// sends nothing itself: the route checks and counts the reply, the worker sends it. A refusal shows
// its code in words, inbox's where it has them (contacts' person_suppressed among them), else its
// module's (src/api/errors.ts errorOwner), with Try again. Try again, or Send on the same text after
// a failure, sends the failed press's key again, so a press whose answer was lost makes no second
// reply (as contacts' never-contact form does); another text takes a new key. Above the box, the AI's
// draft (reply-draft.tsx), whose Use draft puts its text in the box, replacing it: nothing more.
"use client";

import { Button, ErrorState, TextArea } from "@whytide/ui";
import { Send } from "@whytide/ui/icons";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type { ThreadResponse } from "../../schemas/threads.ts";
import { REPLY_ROWS } from "./constants.ts";
import { ownerOf } from "./owner.tsx";
import { ReplyDraft } from "./reply-draft.tsx";

type Props = {
  workspace: string;
  threadId: string;
  reply: ThreadResponse["reply"];
  /** The thread read again, the new reply in it. */
  onSent: () => Promise<void>;
};
/** A press that failed: its code, and its text, which a press again sends with the same key. */
type Failure = { readonly code: string; readonly text: string };

export function ReplyBox({ workspace, threadId, reply, onSent }: Props) {
  const t = useTranslations("inbox");
  const messages = useMessages();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const running = useRef(false);
  /** The failed press's text and key, until a press succeeds. */
  const last = useRef<{ readonly text: string; readonly key: string }>(undefined);

  async function send(body: string) {
    if (running.current) return;
    running.current = true;
    setSending(true);
    setFailure(undefined);
    const key = last.current?.text === body ? last.current.key : crypto.randomUUID();
    try {
      const answer = await browserApi().POST(
        "/v1/workspaces/{workspaceId}/inbox/threads/{id}/replies",
        {
          params: {
            path: { workspaceId: workspace, id: threadId },
            header: { "Idempotency-Key": key },
          },
          body: { text: body },
        },
      );
      if (!answer.response.ok) {
        last.current = { text: body, key };
        setFailure({ code: new ApiError(answer.response.status, answer.error).code, text: body });
        return;
      }
      last.current = undefined;
      setText("");
      await onSent();
    } catch {
      last.current = { text: body, key };
      setFailure({ code: "internal_error", text: body });
    } finally {
      running.current = false;
      setSending(false);
    }
  }

  const owner = failure && ownerOf(failure.code, messages);
  return (
    <>
      {/* The AI's draft only fills the box: Send below is the one press that sends. */}
      <ReplyDraft workspace={workspace} threadId={threadId} onUse={setText} />
      <form
        className="mt-6 grid max-w-3xl gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim() !== "") void send(text);
        }}
      >
        <TextArea
          label={t("reply.label")}
          placeholder={t("reply.placeholder")}
          rows={REPLY_ROWS}
          maxLength={reply.textMax}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={sending} disabled={text.trim() === ""}>
            <Send aria-hidden="true" className="rtl:-scale-x-100" />
            {t("reply.send")}
          </Button>
        </div>
        {owner && failure && (
          <ErrorState
            module={owner.module}
            code={owner.code}
            onRetry={() => void send(failure.text)}
          />
        )}
      </form>
    </>
  );
}

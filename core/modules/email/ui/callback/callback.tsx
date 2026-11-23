"use client";
// The callback's work in the browser: it reads `code`, `state` and `error` from the address, replaces
// the address with the bare path before anything else, posts the state and the code with the
// session's cookie, then opens the workspace's mailboxes screen. A refusal, or the provider's `error`
// (the member said no), shows its message and a link back. The workspace is the state's first part.
import { ErrorState, Link, LoadingState } from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { STATE_NONCE, STATE_WORKSPACE_ID } from "../../domain/constants.ts";

/** The workspace a state names, `<workspaceId>.<nonce>` as the api parses it; else undefined. */
function workspaceOf(state: string): string | undefined {
  const dot = state.lastIndexOf(".");
  const workspaceId = state.slice(0, dot);
  const valid = STATE_WORKSPACE_ID.test(workspaceId) && STATE_NONCE.test(state.slice(dot + 1));
  return dot > 0 && valid ? workspaceId : undefined;
}

export function Callback() {
  const t = useTranslations("email.callback");
  const router = useRouter();
  const started = useRef(false);
  const [failure, setFailure] = useState<{ code: string; workspaceId?: string }>();

  useEffect(() => {
    if (started.current) return; // once, though React mounts an effect twice in development
    started.current = true;
    const params = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    const [code, state] = [params.get("code"), params.get("state") ?? ""];
    const workspaceId = workspaceOf(state);
    if (params.has("error") || code === null || workspaceId === undefined) {
      setFailure({
        code: params.has("error") ? "consent_refused" : "connect_state_invalid",
        workspaceId,
      });
      return;
    }
    data(
      browserApi().POST("/v1/workspaces/{workspaceId}/email/mailboxes/callback", {
        params: { path: { workspaceId } },
        body: { state, code },
      }),
    ).then(
      () => router.replace(`/w/${encodeURIComponent(workspaceId)}/mailboxes`),
      (error: unknown) => {
        const failed = error instanceof ApiError ? error.code : "internal_error";
        setFailure({ code: failed, workspaceId });
      },
    );
  }, [router]);

  if (failure === undefined) return <LoadingState />;
  const back = failure.workspaceId
    ? `/w/${encodeURIComponent(failure.workspaceId)}/mailboxes`
    : "/";
  return (
    <div className="grid gap-4">
      {failure.code === "consent_refused" ? (
        <p role="alert" className="text-ink-muted">
          {t("refused")}
        </p>
      ) : (
        <ErrorState module="email" code={failure.code} />
      )}
      <Link href={back}>{t("back")}</Link>
    </div>
  );
}

"use client";
// The Invitations page's content (README.md "Invites"): GET /v1/invitations, the caller's own open
// invites. Without a session, 401, the sentence and the way to sign in, back here after it; with one,
// each invite with its workspace, role, inviter and expiry, and Accept, which lands on the workspace;
// none, the sentence saying so and the way into the app. Loading, and an error with a retry; a
// refused accept, the invite expired or revoked since, in words above the list read again.
import { Badge, Button, ButtonLink, ErrorState, LoadingState } from "@whytide/ui";
import { Check, LogIn } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { INVITATIONS_PATH } from "../../domain/constants.ts";
import type { InvitationResponse } from "../../schemas/invites.ts";

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const DAY = { dateStyle: "medium" } as const;
const SIGN_IN = `/sign-in?next=${encodeURIComponent(INVITATIONS_PATH)}`;

export function Invitations() {
  const t = useTranslations("identity.invitations");
  const format = useFormatter();
  /** Undefined while it loads; null without a session. */
  const [invitations, setInvitations] = useState<InvitationResponse[] | null>();
  const [failure, setFailure] = useState<string>();
  const [refusal, setRefusal] = useState<string>();
  /** The invite an accept is on. */
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      const answer = await data(browserApi().GET("/v1/invitations"));
      setInvitations(answer.invitations);
      setFailure(undefined);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return setInvitations(null);
      setFailure(codeOf(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function accept(id: string) {
    setRefusal(undefined);
    setBusy(id);
    try {
      const { slug } = await data(
        browserApi().POST("/v1/invitations/{id}/accept", { params: { path: { id } } }),
      );
      // A whole load: the shell reads the new membership.
      window.location.assign(`/w/${encodeURIComponent(slug)}`);
      return;
    } catch (error) {
      setRefusal(codeOf(error));
    }
    await load();
    setBusy(undefined);
  }

  if (invitations === undefined) {
    if (failure === undefined) return <LoadingState />;
    return <ErrorState module="identity" code={failure} onRetry={load} />;
  }
  if (invitations === null) {
    return (
      <div className="grid gap-4">
        <p className="text-ink-muted">{t("signed_out.body")}</p>
        <ButtonLink href={SIGN_IN} variant="primary">
          <LogIn aria-hidden="true" />
          {t("signed_out.action")}
        </ButtonLink>
      </div>
    );
  }
  const roleText = { Owner: t("role.owner"), Admin: t("role.admin"), Member: t("role.member") };
  return (
    <div className="grid gap-4">
      {refusal ? <ErrorState module="identity" code={refusal} /> : null}
      {invitations.length === 0 ? (
        <>
          <p className="text-ink-muted">{t("empty")}</p>
          <ButtonLink href="/" variant="primary">
            {t("open_app")}
          </ButtonLink>
        </>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-4 shadow-xs">
          {invitations.map((invitation) => {
            const { id, workspaceName, role, invitedByName } = invitation;
            const day = format.dateTime(new Date(invitation.expiresAt), DAY);
            return (
              <li key={id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="grid min-w-0 flex-1 basis-48">
                  <span className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    <span className="break-all">{workspaceName}</span>
                    <Badge tone={role === "Owner" ? "accent" : "neutral"}>{roleText[role]}</Badge>
                  </span>
                  <span className="text-sm text-ink-muted">
                    {invitedByName === null
                      ? t("item.expires", { date: day })
                      : t("item.invited_by", { name: invitedByName, date: day })}
                  </span>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  aria-label={t("accept.label", { workspace: workspaceName })}
                  loading={busy === id}
                  disabled={busy !== undefined && busy !== id}
                  onClick={() => void accept(id)}
                >
                  <Check aria-hidden="true" />
                  {t("accept.action")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

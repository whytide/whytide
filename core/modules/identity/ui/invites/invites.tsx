"use client";
// The invites, loaded in the browser (README.md "Invites"): the loading state, the error state with a
// retry, then the form (an email, the role Owner or Member, Invite) above the workspace's invites not
// accepted, the latest first, each with its role, its state, its expiry and its mail. Revoke on an
// open one, after a confirmation; "Send again" on an expired or a revoked one, the same POST, which
// renews it and mails it. The mail's outcome shows in a toast, a refusal in words above the list.
// A Member's read is 403 forbidden: the hint that only an Owner invites teammates, with no form.
// tenancy's Members is a link away.
import {
  Badge,
  Button,
  ButtonLink,
  Dialog,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  TextField,
  Toast,
} from "@whytide/ui";
import { Ban, Send, UserPlus, Users } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { INVITE_ROLES, type InviteRole, TOAST_MS } from "../../domain/constants.ts";
import type { CreateInviteResponse, InviteResponse } from "../../schemas/invites.ts";

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const isInviteRole = (role: string): role is InviteRole => INVITE_ROLES.some((one) => one === role);
const DAY = { dateStyle: "medium" } as const;

/** A toast's message and its setter; a message clears itself after TOAST_MS. */
function useToast() {
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}

export function Invites({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("identity.invites");
  const format = useFormatter();
  /** Undefined while it loads. */
  const [invites, setInvites] = useState<InviteResponse[]>();
  /** The list's read that failed, `forbidden` for a Member. */
  const [failure, setFailure] = useState<string>();
  /** An invite or a revoke the API refused. */
  const [refusal, setRefusal] = useState<string>();
  /** The form's invite, or the row's id a send or a revoke is on. */
  const [busy, setBusy] = useState<string>();
  const [revoking, setRevoking] = useState<InviteResponse>();
  const [role, setRole] = useState<InviteRole>("Member");
  const [toast, setToast] = useToast();

  const load = useCallback(async () => {
    try {
      const answer = await data(
        browserApi().GET("/v1/workspaces/{workspaceId}/identity/invites", {
          params: { path: { workspaceId } },
        }),
      );
      setInvites(answer.invites);
      setFailure(undefined);
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The mail's outcome in words: sent, skipped while the app has no public address, or failed. */
  function said({ invite, mail }: CreateInviteResponse): string {
    if (mail === "sent") return t("toast.sent", { email: invite.email });
    return mail === "skipped" ? t("toast.skipped") : t("toast.failed");
  }

  /** The invite, a new one or one renewed, then the list read again. */
  async function send(email: string, chosen: InviteRole, on: string): Promise<boolean> {
    setRefusal(undefined);
    setBusy(on);
    let sent = false;
    try {
      const answer = await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/identity/invites", {
          params: { path: { workspaceId } },
          body: { email, role: chosen },
        }),
      );
      setToast(said(answer));
      sent = true;
    } catch (error) {
      setRefusal(codeOf(error));
    }
    await load();
    setBusy(undefined);
    return sent;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    if (await send(email, role, "form")) form.reset();
  }

  async function revoke(invite: InviteResponse) {
    const { id } = invite;
    setRevoking(undefined);
    setRefusal(undefined);
    setBusy(id);
    try {
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/identity/invites/{id}/revoke", {
          params: {
            path: { workspaceId, id },
            header: { "Idempotency-Key": crypto.randomUUID() },
          },
        }),
      );
      setToast(t("toast.revoked"));
    } catch (error) {
      setRefusal(codeOf(error));
    }
    await load();
    setBusy(undefined);
  }

  const members = (
    <ButtonLink href={`/w/${workspaceId}/members`}>
      <Users aria-hidden="true" />
      {t("members")}
    </ButtonLink>
  );
  if (invites === undefined) {
    if (failure === undefined) return <LoadingState />;
    if (failure === "forbidden") {
      return <EmptyState message={t("hint")} action={members} />;
    }
    return <ErrorState module="identity" code={failure} onRetry={load} />;
  }
  const roleText = { Owner: t("role.owner"), Admin: t("role.admin"), Member: t("role.member") };
  const stateText = {
    open: t("state.open"),
    expired: t("state.expired"),
    revoked: t("state.revoked"),
  };
  const roleOptions = INVITE_ROLES.map((one) => ({ value: one, label: roleText[one] }));
  return (
    <div className="grid gap-4">
      <form
        onSubmit={submit}
        className="flex flex-wrap items-end gap-3 rounded-xl border border-line bg-surface p-4 shadow-xs"
      >
        <div className="min-w-0 flex-1 basis-56 [&_.wt-field]:min-w-0">
          <TextField
            name="email"
            type="email"
            required
            autoComplete="off"
            label={t("form.email")}
          />
        </div>
        <div className="w-36 [&_.wt-field]:min-w-0">
          <Select
            label={t("form.role")}
            value={role}
            options={roleOptions}
            onChange={(event) => {
              const chosen = event.target.value;
              if (isInviteRole(chosen)) setRole(chosen);
            }}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={busy === "form"}
          disabled={busy !== undefined && busy !== "form"}
        >
          <UserPlus aria-hidden="true" />
          {t("form.submit")}
        </Button>
      </form>
      <div className="flex justify-end">{members}</div>
      {failure ? <ErrorState module="identity" code={failure} onRetry={load} /> : null}
      {refusal ? <ErrorState module="identity" code={refusal} /> : null}
      {invites.length === 0 ? (
        <EmptyState message={t("empty")} />
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line bg-surface px-4 shadow-xs">
          {invites.map((invite) => {
            const day = format.dateTime(new Date(invite.expiresAt), DAY);
            // Send again renews an expired or a revoked invite with its own role.
            const again = invite.state !== "open" && isInviteRole(invite.role) ? invite.role : null;
            return (
              <li key={invite.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <div className="grid min-w-0 flex-1 basis-48">
                  <span className="break-all font-medium text-ink">{invite.email}</span>
                  <span className="flex flex-wrap gap-x-3 text-sm text-ink-muted">
                    <span>
                      {invite.state === "open"
                        ? t("expiry.open", { date: day })
                        : invite.state === "expired"
                          ? t("expiry.expired", { date: day })
                          : t("expiry.revoked")}
                    </span>
                    <span>
                      {invite.mailedAt === null
                        ? t("mailed.no")
                        : t("mailed.yes", {
                            date: format.dateTime(new Date(invite.mailedAt), DAY),
                          })}
                    </span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={invite.role === "Owner" ? "accent" : "neutral"}>
                    {roleText[invite.role]}
                  </Badge>
                  <Badge tone={invite.state === "open" ? "success" : "warning"}>
                    {stateText[invite.state]}
                  </Badge>
                  {again === null ? null : (
                    <Button
                      size="sm"
                      aria-label={t("send_again.label", { email: invite.email })}
                      loading={busy === invite.id}
                      disabled={busy !== undefined && busy !== invite.id}
                      onClick={() => void send(invite.email, again, invite.id)}
                    >
                      <Send aria-hidden="true" />
                      {t("send_again.action")}
                    </Button>
                  )}
                  {invite.state === "open" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("revoke.label", { email: invite.email })}
                      loading={busy === invite.id}
                      disabled={busy !== undefined && busy !== invite.id}
                      onClick={() => setRevoking(invite)}
                    >
                      <Ban aria-hidden="true" />
                      {t("revoke.action")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog
        open={revoking !== undefined}
        onClose={() => setRevoking(undefined)}
        title={t("revoke.title", { email: revoking?.email ?? "" })}
        actions={
          <Button variant="danger" onClick={() => revoking && revoke(revoking)}>
            <Ban aria-hidden="true" />
            {t("revoke.action")}
          </Button>
        }
      >
        <p className="text-ink-muted">{t("revoke.body")}</p>
      </Dialog>
      <Toast message={toast} />
    </div>
  );
}

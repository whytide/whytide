"use client";
// The mailboxes, loaded in the browser (README.md "Screen"): the loading state, the error state with
// a retry, then the member's own mailbox: connected, its card (mailbox-card.tsx); disconnected, the
// reconnect banner with the reason in words; none, the connect card with the recommended setup. An
// Owner, who reads every mailbox, also sees a read-only card per teammate's mailbox. Connect and
// Reconnect ask for the provider's consent address and go there; the consent comes back to the
// callback page (../callback/).
import { Button, ErrorState, LoadingState } from "@whytide/ui";
import { CircleAlert, RotateCw } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type { MailboxResponse } from "../../schemas/mailboxes.ts";
import { ConnectCard, MailboxCard, TeammateCard } from "./mailbox-card.tsx";

type Provider = MailboxResponse["provider"];
const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export function Mailboxes({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations("email.mailboxes");
  /** Undefined while it loads. */
  const [mailboxes, setMailboxes] = useState<MailboxResponse[]>();
  const [failure, setFailure] = useState<string>();
  const [connecting, setConnecting] = useState<Provider>();

  const load = useCallback(async () => {
    setFailure(undefined);
    try {
      const path = { workspaceId };
      const answer = await data(
        browserApi().GET("/v1/workspaces/{workspaceId}/email/mailboxes", { params: { path } }),
      );
      setMailboxes(answer.mailboxes);
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The provider's consent screen, which comes back to the callback page. */
  async function connect(provider: Provider) {
    setConnecting(provider);
    setFailure(undefined);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { url } = await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/email/mailboxes/connect", {
          params: { path: { workspaceId } },
          body: { provider, timeZone },
        }),
      );
      window.location.assign(url);
    } catch (error) {
      setFailure(codeOf(error));
      setConnecting(undefined);
    }
  }

  async function disconnect(mailboxId: string) {
    setFailure(undefined);
    try {
      await data(
        browserApi().DELETE("/v1/workspaces/{workspaceId}/email/mailboxes/{mailboxId}", {
          params: { path: { workspaceId, mailboxId } },
        }),
      );
      await load();
    } catch (error) {
      setFailure(codeOf(error));
    }
  }

  if (mailboxes === undefined && failure === undefined) return <LoadingState />;
  if (mailboxes === undefined) {
    return <ErrorState module="email" code={failure ?? "internal_error"} onRetry={load} />;
  }
  const own = mailboxes.filter((mailbox) => mailbox.mine);
  const connected = own.find((mailbox) => mailbox.status === "connected");
  const latest = own
    .filter((mailbox) => mailbox.status === "disconnected")
    .sort((a, b) => (b.disconnectedAt ?? "").localeCompare(a.disconnectedAt ?? ""))[0];
  const teammates = mailboxes.filter((mailbox) => !mailbox.mine);
  const reason = (mailbox: MailboxResponse) => {
    const address = { address: mailbox.emailAddress };
    if (mailbox.disconnectedReason === "token_revoked") return t("reason.token_revoked", address);
    if (mailbox.disconnectedReason === "member_removed") return t("reason.member_removed", address);
    return t("reason.user", address);
  };
  return (
    <div className="grid gap-6">
      {failure ? <ErrorState module="email" code={failure} /> : null}
      {connected ? (
        <MailboxCard mailbox={connected} onDisconnect={() => disconnect(connected.id)} />
      ) : latest ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-xl border border-warm-dot/30 bg-warm-soft px-4 py-3 text-warm-ink"
        >
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
          <p className="min-w-0 flex-1">{reason(latest)}</p>
          <Button
            size="sm"
            variant="primary"
            loading={connecting !== undefined}
            onClick={() => connect(latest.provider)}
          >
            <RotateCw aria-hidden="true" />
            {t("reconnect")}
          </Button>
        </div>
      ) : null}
      {connected ? null : <ConnectCard connecting={connecting} onConnect={connect} />}
      {teammates.length > 0 ? (
        <section className="grid gap-3">
          <h2 className="font-semibold text-ink">{t("teammates")}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {teammates.map((mailbox) => (
              <li key={mailbox.id}>
                <TeammateCard mailbox={mailbox} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

"use client";
// The cards of the mailboxes screen (README.md "Screen"): the member's own mailbox, its address,
// provider and status, and Disconnect with a confirmation; a teammate's, read-only, with its owner's
// name and status; the connect card, Google or Microsoft, with the recommended setup in words.
import { MAILBOX_PROVIDERS } from "@whytide/providers/mailbox/constants";
import { Badge, Button, Card, Dialog } from "@whytide/ui";
import { CircleCheck, Mail, Unplug } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { MailboxResponse } from "../../schemas/mailboxes.ts";

type Provider = MailboxResponse["provider"];

function Status({ mailbox }: { mailbox: MailboxResponse }) {
  const t = useTranslations("email.mailboxes");
  return mailbox.status === "connected" ? (
    <Badge tone="success">
      <CircleCheck aria-hidden="true" />
      {t("status.connected")}
    </Badge>
  ) : (
    <Badge>
      <Unplug aria-hidden="true" />
      {t("status.disconnected")}
    </Badge>
  );
}

function useProviderName() {
  const t = useTranslations("email.mailboxes.provider");
  return (provider: Provider) => (provider === "google" ? t("google") : t("microsoft"));
}

export function MailboxCard(props: {
  mailbox: MailboxResponse;
  onDisconnect: () => Promise<void>;
}) {
  const { mailbox, onDisconnect } = props;
  const t = useTranslations("email.mailboxes");
  const providerName = useProviderName();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  async function disconnect() {
    setConfirming(false);
    setBusy(true);
    await onDisconnect();
    setBusy(false);
  }
  return (
    <Card title={mailbox.emailAddress} actions={<Status mailbox={mailbox} />}>
      <p className="flex items-center gap-2 text-ink-muted">
        <Mail aria-hidden="true" className="size-4 shrink-0" />
        {providerName(mailbox.provider)}
      </p>
      {mailbox.isFreeConsumer ? <p className="text-ink-muted">{t("free_consumer")}</p> : null}
      <div>
        <Button variant="danger" loading={busy} onClick={() => setConfirming(true)}>
          <Unplug aria-hidden="true" />
          {t("disconnect")}
        </Button>
      </div>
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("disconnect_title")}
        actions={
          <Button variant="danger" onClick={disconnect}>
            {t("disconnect")}
          </Button>
        }
      >
        <p className="text-ink-muted">{t("disconnect_body")}</p>
      </Dialog>
    </Card>
  );
}

export function TeammateCard({ mailbox }: { mailbox: MailboxResponse }) {
  const providerName = useProviderName();
  return (
    <Card title={mailbox.displayName} level={3} actions={<Status mailbox={mailbox} />}>
      <p className="break-all text-ink-muted">{mailbox.emailAddress}</p>
      <p className="text-ink-muted">{providerName(mailbox.provider)}</p>
    </Card>
  );
}

export function ConnectCard(props: {
  connecting: Provider | undefined;
  onConnect: (provider: Provider) => void;
}) {
  const t = useTranslations("email.mailboxes");
  const label = (provider: Provider) =>
    provider === "google" ? t("connect.google") : t("connect.microsoft");
  return (
    <Card title={t("connect.title")} description={t("connect.body")}>
      <div className="flex flex-wrap gap-2">
        {MAILBOX_PROVIDERS.map((provider) => (
          <Button
            key={provider}
            variant={provider === "google" ? "primary" : "secondary"}
            loading={props.connecting === provider}
            disabled={props.connecting !== undefined && props.connecting !== provider}
            onClick={() => props.onConnect(provider)}
          >
            <Mail aria-hidden="true" />
            {label(provider)}
          </Button>
        ))}
      </div>
      <div className="grid gap-2">
        <h3 className="font-medium text-ink">{t("setup.title")}</h3>
        <ul className="grid list-disc gap-1 ps-5 text-ink-muted">
          <li>{t("setup.domain")}</li>
          <li>{t("setup.mailboxes")}</li>
          <li>{t("setup.sender")}</li>
        </ul>
      </div>
    </Card>
  );
}

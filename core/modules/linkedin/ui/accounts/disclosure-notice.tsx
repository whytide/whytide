"use client";
// The sending disclosure's notice (README.md "Screen"), on the card of an account whose owner has not
// accepted the risk disclosure for sending (sendingDisclosureRequired): it reads, and sends nothing
// until then. Its owner's "Read and accept" opens a Dialog with the disclosure and the personal-account
// box; Accept stays off until the box is ticked, Cancel changes nothing, and each press sends a key
// of its own (core/apps/api "Request protection"); the Dialog's content exists only while it is open.
// Another member reads that the owner accepts. A failed press shows its code in words, in the Dialog,
// with a retry.
import { Button, Checkbox, Dialog, ErrorState } from "@whytide/ui";
import { Lock, ShieldAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { DISCLOSURE_VERSION } from "../../domain/disclosure/constants.ts";
import type { AccountResponse } from "../../schemas/accounts.ts";
import { Disclosure } from "./connect-panel.tsx";

type Props = {
  workspaceId: string;
  account: AccountResponse;
  /** Accepted: the screen asks for the account again and says so. */
  onAccepted: () => Promise<unknown>;
};

const NOTE =
  "grid gap-3 rounded-lg border border-warm-dot/30 bg-warm-soft px-3 py-2.5 text-warm-ink";

export function DisclosureNotice({ workspaceId, account, onAccepted }: Props) {
  const t = useTranslations("linkedin.disclosure");
  const connect = useTranslations("linkedin.connect");
  const [open, setOpen] = useState(false);
  const [personalAccount, setPersonalAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  function close() {
    setOpen(false);
    setPersonalAccount(false);
    setFailure(undefined);
  }

  async function accept() {
    setBusy(true);
    setFailure(undefined);
    const header = { "Idempotency-Key": crypto.randomUUID() };
    try {
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}/disclosure", {
          params: { path: { workspaceId, id: account.id }, header },
          body: { version: DISCLOSURE_VERSION, personalAccount },
        }),
      );
      close();
      await onAccepted();
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={NOTE}>
      <p className="flex items-start gap-2.5">
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("notice")}
      </p>
      {account.mine ? (
        <div>
          <Button variant="primary" onClick={() => setOpen(true)}>
            {t("review")}
          </Button>
        </div>
      ) : (
        <p className="flex items-start gap-2.5 text-sm">
          <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("owner_only")}
        </p>
      )}
      <Dialog
        open={open}
        onClose={close}
        title={t("title")}
        actions={
          <Button variant="primary" loading={busy} disabled={!personalAccount} onClick={accept}>
            {t("accept")}
          </Button>
        }
      >
        {open ? (
          <div className="my-3 grid gap-3">
            <Disclosure />
            <Checkbox
              label={connect("personal_account")}
              checked={personalAccount}
              onChange={(event) => setPersonalAccount(event.target.checked)}
            />
            {failure ? <ErrorState module="linkedin" code={failure} onRetry={accept} /> : null}
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}

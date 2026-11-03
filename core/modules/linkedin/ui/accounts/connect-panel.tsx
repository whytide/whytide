"use client";
// The risk disclosure and Connect (README.md "Screen"), a card: the sentence that no account is
// connected yet heads it on the empty screen (`intro`); then the disclosure, its two boxes, the
// acknowledgement and the personal account, and Connect, which stays off until both are ticked, sends
// the browser's time zone and the disclosure's version and goes to the provider's hosted page; the
// api refuses a connect without them as well (disclosure_required, personal_account_required). A
// failed connect shows its code in words, with a retry. It also reconnects an account whose provider
// needs a new sign-in. Disclosure is the disclosure's box, which the account's card shows again on
// demand and the acceptance's Dialog shows (disclosure-notice.tsx).
import { Button, Checkbox, ErrorState } from "@whytide/ui";
import { ArrowUpRight, Link2, ShieldAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { DISCLOSURE_VERSION } from "../../domain/disclosure/constants.ts";

export function ConnectPanel({ workspaceId, intro }: { workspaceId: string; intro?: string }) {
  const t = useTranslations("linkedin.connect");
  const [acknowledged, setAcknowledged] = useState(false);
  const [personalAccount, setPersonalAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const id = useId();

  async function connect() {
    setBusy(true);
    setFailure(undefined);
    try {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const { url } = await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/linkedin/accounts/connect", {
          params: { path: { workspaceId } },
          body: { timeZone, acknowledged, disclosureVersion: DISCLOSURE_VERSION, personalAccount },
        }),
      );
      window.location.assign(url);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.code : "internal_error");
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      className="grid min-w-0 content-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent-ink ring-1 ring-accent/20 ring-inset"
        >
          <Link2 className="size-5" />
        </span>
        <div className="grid min-w-0 gap-1 pt-2">
          <h2 id={`${id}-title`} className="font-semibold text-ink">
            {t("title")}
          </h2>
          {intro ? <p className="text-ink-muted">{intro}</p> : null}
        </div>
      </div>
      <Disclosure />
      <div className="grid gap-3">
        <Checkbox
          label={t("acknowledge")}
          checked={acknowledged}
          onChange={(event) => setAcknowledged(event.target.checked)}
        />
        <Checkbox
          label={t("personal_account")}
          checked={personalAccount}
          onChange={(event) => setPersonalAccount(event.target.checked)}
        />
      </div>
      <div>
        <Button
          variant="primary"
          loading={busy}
          disabled={!acknowledged || !personalAccount}
          onClick={connect}
        >
          {t("button")}
          {!busy && <ArrowUpRight aria-hidden="true" />}
        </Button>
      </div>
      {failure ? <ErrorState module="linkedin" code={failure} onRetry={connect} /> : null}
    </section>
  );
}

/** The risk disclosure, in its box: what Whytide reads and sends with the account, and the risk to it. */
export function Disclosure() {
  const t = useTranslations("linkedin.connect");
  return (
    <p className="flex items-start gap-2.5 rounded-lg bg-muted px-4 py-3 leading-relaxed text-pretty text-ink">
      <ShieldAlert aria-hidden="true" className="mt-1 size-4 shrink-0 text-ink-muted" />
      {t("disclosure")}
    </p>
  );
}

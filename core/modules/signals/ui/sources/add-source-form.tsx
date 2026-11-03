"use client";
// The add form (README.md "Screen"), a card on top of the screen: a LinkedIn post's URL across, then
// a label and the sender account, from linkedin's accounts of the workspace, the user's own connected
// one first, beside Add on a wide card. The api's refusals show inline: a URL that is not a post's
// under the field (signal_config_invalid), the limit of enabled sources and anything else in the form
// (signal_sources_limit).
import { Button, ErrorState, Link, Select, TextField } from "@whytide/ui";
import { Plus, Unplug } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import type { Account } from "./source-list.tsx";

/** The account the form starts on: the user's own connected one, else any connected, else the first. */
function firstChoice(accounts: Account[]): string {
  const connected = accounts.filter(({ status }) => status === "connected");
  return (connected.find(({ mine }) => mine) ?? connected[0] ?? accounts[0])?.id ?? "";
}

export function AddSourceForm({
  workspaceId,
  accounts,
  onAdded,
}: {
  workspaceId: string;
  accounts: Account[];
  /** Reads the screen again, once the source is saved. */
  onAdded: () => Promise<void>;
}) {
  const t = useTranslations("signals");
  const [postUrl, setPostUrl] = useState("");
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState(() => firstChoice(accounts));
  const [busy, setBusy] = useState(false);
  const [urlRefused, setUrlRefused] = useState(false);
  const [failure, setFailure] = useState<string>();

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setUrlRefused(false);
    setFailure(undefined);
    try {
      const body = { kind: "post_engagers", config: { postUrl }, label, senderAccountId: account };
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/signals/sources", {
          params: { path: { workspaceId } },
          body,
        }),
      );
      setPostUrl("");
      setLabel("");
      await onAdded();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "internal_error";
      if (code === "signal_config_invalid") setUrlRefused(true);
      else setFailure(code);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="signals-sources-add"
      className="@container grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <h2 id="signals-sources-add" className="font-semibold text-ink">
        {t("sources.add_title")}
      </h2>
      {accounts.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg bg-muted px-4 py-3">
          <Unplug aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <p className="text-pretty text-ink-muted">
            {t("sources.no_account")}{" "}
            <Link href={`/w/${workspaceId}/linkedin`}>{t("sources.connect_account")}</Link>
          </p>
        </div>
      ) : (
        <form
          onSubmit={add}
          aria-labelledby="signals-sources-add"
          className="grid gap-4 [&_.wt-field]:min-w-0"
        >
          <TextField
            label={t("sources.post_url")}
            hint={t("sources.post_url_hint")}
            error={urlRefused ? t("errors.signal_config_invalid") : undefined}
            type="url"
            required
            value={postUrl}
            onChange={(event) => setPostUrl(event.target.value)}
          />
          <div className="grid items-end gap-4 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
            <TextField
              label={t("sources.label")}
              required
              maxLength={100}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Select
              label={t("sources.account")}
              value={account}
              onChange={(event) => setAccount(event.target.value)}
              options={accounts.map(({ id, label: name }) => ({ value: id, label: name }))}
            />
            <span className="justify-self-start">
              <Button type="submit" variant="primary" loading={busy}>
                {busy ? null : <Plus aria-hidden="true" />}
                {t("sources.add")}
              </Button>
            </span>
          </div>
          {failure ? <ErrorState module="signals" code={failure} /> : null}
        </form>
      )}
    </section>
  );
}

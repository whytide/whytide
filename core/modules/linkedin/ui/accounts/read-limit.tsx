"use client";
// The account's daily read limit (README.md "Screen"), under its reads today, for a member with
// linkedin.manage only (the account's canManage; the others see the value on the card): the field
// with the bound the usage answers, the warning in a warm box, and its own Save. The api decides:
// its refusal, read_cap_invalid, shows under the field; another failure in words, with a retry; a
// saved limit in the toast.
import { Button, ErrorState, TextField, Toast } from "@whytide/ui";
import { TriangleAlert } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";

type Props = {
  workspaceId: string;
  accountId: string;
  cap: number;
  /** The highest cap, LINKEDIN_DAILY_READ_CAP_MAX, as the usage answers it. */
  capMax: number;
  /** The limit is saved: the account's new cap. */
  onSaved: (cap: number) => void;
};

/** The field as the api reads it: a number when it reads as one, else the text, which it refuses. */
function asCap(text: string): number | string {
  const value = Number(text);
  return Number.isFinite(value) ? value : text;
}

export function ReadLimit({ workspaceId, accountId, cap, capMax, onSaved }: Props) {
  const t = useTranslations("linkedin");
  const [text, setText] = useState(String(cap));
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [saved, setSaved] = useState<string>();

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setSaving(true);
    setRefused(false);
    setFailure(undefined);
    setSaved(undefined);
    try {
      const account = await data(
        browserApi().PATCH("/v1/workspaces/{workspaceId}/linkedin/accounts/{id}", {
          params: { path: { workspaceId, id: accountId } },
          body: { dailyReadCap: asCap(text) },
        }),
      );
      setSaved(t("read_limit.saved"));
      onSaved(account.dailyReadCap);
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "internal_error";
      if (code === "read_cap_invalid") setRefused(true);
      else setFailure(code);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-3 [&_.wt-field]:min-w-0">
      <TextField
        label={t("account.cap_label")}
        hint={t("read_limit.hint", { max: capMax })}
        error={refused ? t("errors.read_cap_invalid") : undefined}
        inputMode="numeric"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <p className="flex items-start gap-2 rounded-lg bg-warm-soft px-3 py-2.5 text-sm text-warm-ink">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t("read_limit.warning")}
      </p>
      <div>
        <Button type="submit" loading={saving}>
          {t("read_limit.save")}
        </Button>
      </div>
      {failure ? <ErrorState module="linkedin" code={failure} onRetry={() => void save()} /> : null}
      <Toast message={saved} />
    </form>
  );
}

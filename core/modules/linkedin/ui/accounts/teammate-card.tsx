"use client";
// A teammate's account on an Owner's LinkedIn screen (README.md "Screen", gamma-p6-070), under the
// Owner's own: titled with its owner's name, or as a former member's once they were removed; its
// label, its status as a badge and its time zone; while it needs the sending disclosure, the hint
// that its owner accepts it (disclosure-notice.tsx); and its pause, by the rules the route's flags
// carry (pause-switch.tsx). Its health and today's usage sit beside it (accounts.tsx). Nothing else
// to edit: the account is its owner's own LinkedIn account.
import { Avatar } from "@whytide/ui";
import { Globe } from "@whytide/ui/icons";
import { useTranslations } from "next-intl";
import { useId } from "react";
import type { AccountResponse } from "../../schemas/accounts.ts";
import { FACT, StatusBadge } from "./account-card.tsx";
import { DisclosureNotice } from "./disclosure-notice.tsx";
import { PauseSwitch } from "./pause-switch.tsx";

type Props = {
  workspaceId: string;
  account: AccountResponse;
  /** The account changed here: the screen asks for it again. */
  onChange: () => Promise<unknown>;
};

export function TeammateCard({ workspaceId, account, onChange }: Props) {
  const t = useTranslations("linkedin.accounts");
  const facts = useTranslations("linkedin.account");
  const id = useId();
  const name = account.ownerName;
  return (
    <section
      aria-labelledby={`${id}-title`}
      className="@container grid min-w-0 content-start gap-5 rounded-xl border border-line bg-surface p-5 shadow-xs sm:p-6"
    >
      <header className="flex min-w-0 items-center gap-3">
        <Avatar name={name ?? account.label} size="lg" />
        <div className="grid min-w-0 gap-0.5">
          <h3 id={`${id}-title`} className="text-base font-semibold wrap-break-word text-ink">
            {name === null ? t("teammate.removed") : t("teammate.title", { name })}
          </h3>
          <p className="text-sm wrap-break-word text-ink-muted">{account.label}</p>
        </div>
      </header>
      <dl className="grid gap-2 @lg:grid-cols-2 @lg:gap-3">
        <div className={FACT}>
          <dt className="text-xs font-medium text-ink-muted">{facts("status_label")}</dt>
          <dd className="flex">
            <StatusBadge status={account.status} />
          </dd>
        </div>
        <div className={FACT}>
          <dt className="text-xs font-medium text-ink-muted">{facts("time_zone")}</dt>
          <dd className="flex items-center gap-1.5 font-medium wrap-anywhere text-ink">
            <Globe aria-hidden="true" className="size-3.5 shrink-0 text-ink-muted" />
            {account.timeZone}
          </dd>
        </div>
      </dl>
      {account.sendingDisclosureRequired && account.status !== "disconnected" ? (
        <DisclosureNotice workspaceId={workspaceId} account={account} onAccepted={onChange} />
      ) : null}
      <PauseSwitch workspaceId={workspaceId} account={account} onChange={onChange} />
    </section>
  );
}

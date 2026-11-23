// The LinkedIn senders' section of the Health page (page.tsx), read in the browser: linkedin's
// accounts as the route answers the reader (a Member their own, an Owner every member's,
// gamma-p6-070; the page filters nothing), then a card per account in the route's order, each
// reading its own health (sender-card.tsx). The section's states: the loading state while the
// accounts are read; a refused read in words, its module's (src/api/errors.ts errorOwner), with Try
// again, which reads again; no account, the empty state, with the way to connect one. Whatever this
// section shows, another section of the page stays as it is.
"use client";

import { EmptyState, ErrorState, Link, LoadingState, Skeleton } from "@whytide/ui";
import { ApiError, browserApi, data, errorOwner } from "@whytide/web/api/browser";
import { useMessages, useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { linkedinScreen } from "../constants.ts";
import { ACCOUNTS_PATH, SECTION_LOADING_LINES } from "./constants.ts";
import { SenderCard } from "./sender-card.tsx";

const readAccounts = (workspace: string) =>
  browserApi().GET(ACCOUNTS_PATH, { params: { path: { workspaceId: workspace } } });
/** An account as linkedin's list answers it. */
export type Account = NonNullable<
  Awaited<ReturnType<typeof readAccounts>>["data"]
>["accounts"][number];

/** The accounts, or the digest of the read's refusal (`api:<code>`), or neither while reading. */
type Read = { accounts: Account[] } | { failed: string } | undefined;

const digestOf = (error: unknown) =>
  error instanceof ApiError ? error.digest : new ApiError(500, undefined).digest;

export function Senders({ workspace }: { workspace: string }) {
  const t = useTranslations("campaigns.health.senders");
  const messages = useMessages();
  const id = useId();
  const [read, setRead] = useState<Read>();

  const load = useCallback(async () => {
    setRead(undefined);
    try {
      setRead({ accounts: (await data(readAccounts(workspace))).accounts });
    } catch (error) {
      setRead({ failed: digestOf(error) });
    }
  }, [workspace]);

  useEffect(() => {
    void load();
  }, [load]);

  function body() {
    if (read === undefined) {
      return (
        <div aria-busy="true" className="grid gap-3">
          <LoadingState />
          <Skeleton lines={SECTION_LOADING_LINES} />
        </div>
      );
    }
    if ("failed" in read) {
      const owner = errorOwner({ digest: read.failed }, messages);
      return (
        <div className="grid max-w-3xl gap-3">
          <p className="font-medium text-ink">{t("error")}</p>
          <ErrorState module={owner.module} code={owner.code} onRetry={() => void load()} />
        </div>
      );
    }
    if (read.accounts.length === 0) {
      return (
        <EmptyState
          message={t("empty")}
          action={<Link href={linkedinScreen(workspace)}>{t("connect")}</Link>}
        />
      );
    }
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        {read.accounts.map((account) => (
          <SenderCard key={account.id} workspace={workspace} account={account} />
        ))}
      </div>
    );
  }

  return (
    <section aria-labelledby={id} className="grid gap-4">
      <div className="grid gap-1">
        <h2 id={id} className="text-lg font-semibold text-ink">
          {t("title")}
        </h2>
        <p className="text-pretty text-ink-muted">{t("description")}</p>
      </div>
      {body()}
    </section>
  );
}

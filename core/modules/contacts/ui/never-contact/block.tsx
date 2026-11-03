// The one-click blocks (README.md "Screens"): the items of a Menu, "This person" and "Their
// company" in the lead page's Never contact menu (NeverContactMenu, header.tsx), "Never contact this
// person" and "Never contact their company" in the lead list's row menu; the company's only when the
// person has one. A click posts POST …/contacts/suppression, the person by id or their company by id, with
// an Idempotency-Key of its own, which its retry sends again (core/apps/api "Request protection");
// while it runs the items wait, so a double click adds one entry. Then the menu closes and the
// owner's toast says so, and the lead page is read again for its badge. A failure shows its code in
// words in the menu, with a retry.
"use client";

import { ErrorState, Menu, MenuItem, Toast } from "@whytide/ui";
import { Ban, Building2, UserRound } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState } from "react";
import { TOAST_MS } from "./constants.ts";

/** What a block is on: the person, or their company. */
export type BlockKind = "person" | "company";
/** The person a block is for: their id and their company's, null without one. */
type Blocked = { personId: string; companyId: string | null };
type Failure = { readonly code: string; readonly retry: () => void };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

/** A toast's message and its setter; a message clears itself after TOAST_MS. */
export function useToast() {
  const [toast, setToast] = useState<string>();
  useEffect(() => {
    if (toast === undefined) return;
    const timer = setTimeout(() => setToast(undefined), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return [toast, setToast] as const;
}

/**
 * A Menu's block items, in `labels`' words: the person, and their company when they have one.
 * `onBlocked` once the api added the entry, or answered the one already there.
 */
export function NeverContactItems(
  props: Blocked & {
    workspace: string;
    labels: Record<BlockKind, string>;
    onBlocked: (kind: BlockKind) => void;
  },
) {
  const { workspace, personId, companyId, labels, onBlocked } = props;
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure>();
  const running = useRef(false);
  const items = useRef<HTMLDivElement>(null);

  async function block(kind: BlockKind, key = crypto.randomUUID()) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setFailure(undefined);
    const body =
      kind === "person" ? { kind, personId } : { kind, companyId: companyId ?? undefined };
    try {
      await data(
        browserApi().POST("/v1/workspaces/{workspaceId}/contacts/suppression", {
          params: { path: { workspaceId: workspace }, header: { "Idempotency-Key": key } },
          body,
        }),
      );
      // The Menu's panel closes, as a chosen item closes a menu.
      const panel = items.current?.closest<HTMLElement>("[popover]");
      if (panel?.matches(":popover-open")) panel.hidePopover();
      onBlocked(kind);
    } catch (error) {
      setFailure({ code: codeOf(error), retry: () => void block(kind, key) });
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  return (
    <div ref={items}>
      <MenuItem disabled={busy} onClick={() => block("person")}>
        <UserRound aria-hidden="true" />
        {labels.person}
      </MenuItem>
      {companyId !== null && (
        <MenuItem disabled={busy} onClick={() => block("company")}>
          <Building2 aria-hidden="true" />
          {labels.company}
        </MenuItem>
      )}
      {failure && (
        <div className="px-2.5 pt-1.5 pb-2.5">
          <ErrorState module="contacts" code={failure.code} onRetry={failure.retry} />
        </div>
      )}
    </div>
  );
}

/**
 * The lead page header's Never contact menu, with its toast; once the entry is added, the page is
 * read again, so that the header shows the person's badge.
 */
export function NeverContactMenu(props: Blocked & { workspace: string }) {
  const t = useTranslations("contacts.never_contact");
  const router = useRouter();
  const [toast, setToast] = useToast();
  return (
    <>
      <Menu
        trigger={
          <>
            <Ban aria-hidden="true" className="size-4 shrink-0" />
            {t("menu.trigger")}
          </>
        }
      >
        <NeverContactItems
          {...props}
          labels={{ person: t("menu.person"), company: t("menu.company") }}
          onBlocked={(kind) => {
            setToast(kind === "person" ? t("toast.person") : t("toast.company"));
            startTransition(() => router.refresh());
          }}
        />
      </Menu>
      <Toast message={toast} />
    </>
  );
}

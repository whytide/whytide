// The never-contact screen's body (page.tsx), in the browser: the add form (add-form.tsx), then the
// list, GET …/contacts/suppression a page at a time, newest first, the last read winning, with its
// states: loading, a failed read in words with a retry, and empty, which points to the leads,
// where a block is one click (block.tsx). A row: who or what the entry names (the name when the
// workspace has the person or company, else the URL, the domain or the email address, an address
// entry's name being the person who holds it, gamma-rf-040; "Erased person" once erasure emptied
// the value), the kind, the list (a customer or a competitor for a relationship entry, and an
// opt-out's reason in words), the channel, who added it and when. "You" or "a teammate" compares
// the entry's createdBy with the signed-in user's id (GET /v1/me; without an answer, no one is
// named); "automatically" is the system's, an opt-out found in a reply. Remove lifts an exclusion,
// so only an Owner or an Admin of the workspace has it (suppression.remove; the role from GET
// /v1/me, none before its answer): a blocklist or relationship row's Remove, after its
// confirmation, sends DELETE …/contacts/suppression/{id} and reads the first page again; an
// opt-out has none, since it is never removed. Between the form and the list, the exclusion lists
// (exclusions.tsx, gamma-p2-045), on the same viewer and role; an import or a removal there reads
// the first page again.
"use client";

import {
  Badge,
  Button,
  ButtonLink,
  type Column,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Toast,
} from "@whytide/ui";
import { Building2, Mail, Trash2, UserRound, Users } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  SUPPRESSION_REMOVE_ROLES,
  type SuppressionChannel,
  type SuppressionRelationship,
} from "../../domain/suppression/constants.ts";
import type { SuppressionEntryResponse } from "../../schemas/suppression.ts";
import { AddForm, type Layer } from "./add-form.tsx";
import { type BlockKind, useToast } from "./block.tsx";
import { COMPANY_PAGE, PAGE_SIZE } from "./constants.ts";
import { Exclusions } from "./exclusions.tsx";
import { NeverContactLoading } from "./skeleton.tsx";

type Entry = SuppressionEntryResponse;
/** A page read: its entries, the next page's cursor, and the cursors that led to it. */
type Shown = {
  readonly entries: Entry[];
  readonly next: string | null;
  readonly cursors: string[];
};
/** A read that failed: its code, and the cursors to read again with. */
type Failure = { readonly code: string; readonly cursors: string[] };

/** What a row names: a person or a company, as a block names them, or a person's email address. */
type RowKind = BlockKind | "email";

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
/**
 * An address's entry is an email entry; a company's is on a domain or a company page; a person's on
 * a profile, or emptied.
 */
const kindOf = (entry: Entry): RowKind => {
  if (entry.matchType === "email") return "email";
  return entry.domain !== null || entry.linkedinUrl?.startsWith(COMPANY_PAGE)
    ? "company"
    : "person";
};
const KIND_ICONS = { person: UserRound, company: Building2, email: Mail } as const;

export function NeverContactList({ workspace }: { workspace: string }) {
  const t = useTranslations("contacts.never_contact");
  const format = useFormatter();
  const [shown, setShown] = useState<Shown>();
  const [failure, setFailure] = useState<Failure>();
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState<string>();
  const [lifts, setLifts] = useState(false);
  const [removing, setRemoving] = useState<Entry>();
  const [removeFailed, setRemoveFailed] = useState<string>();
  const [toast, setToast] = useToast();
  const latest = useRef(0);

  const read = useCallback(
    async (cursors: string[]) => {
      const run = ++latest.current;
      setBusy(true);
      try {
        const query = { limit: PAGE_SIZE, cursor: cursors.at(-1) };
        const page = await data(
          browserApi().GET("/v1/workspaces/{workspaceId}/contacts/suppression", {
            params: { path: { workspaceId: workspace }, query },
          }),
        );
        if (run !== latest.current) return;
        setFailure(undefined);
        setShown({ entries: page.entries, next: page.nextCursor, cursors });
      } catch (error) {
        if (run === latest.current) setFailure({ code: codeOf(error), cursors });
      } finally {
        if (run === latest.current) setBusy(false);
      }
    },
    [workspace],
  );

  useEffect(() => {
    void read([]);
    browserApi()
      .GET("/v1/me")
      .then(
        ({ data: me }) => {
          setViewer(me?.user.id);
          const membership = me?.memberships.find(
            ({ workspaceId, slug }) => workspaceId === workspace || slug === workspace,
          );
          setLifts(SUPPRESSION_REMOVE_ROLES.some((role) => role === membership?.role));
        },
        () => undefined,
      );
  }, [read]);

  async function remove(entry: Entry) {
    setRemoving(undefined);
    setRemoveFailed(undefined);
    try {
      await data(
        browserApi().DELETE("/v1/workspaces/{workspaceId}/contacts/suppression/{id}", {
          params: { path: { workspaceId: workspace, id: entry.id } },
        }),
      );
      setToast(t("toast.removed"));
      await read([]);
    } catch (error) {
      setRemoveFailed(codeOf(error));
    }
  }

  const kindText: Record<RowKind, string> = {
    person: t("kind.person"),
    company: t("kind.company"),
    email: t("kind.email"),
  };
  const channelText: Record<SuppressionChannel, string> = {
    all: t("channel.all"),
    linkedin: t("channel.linkedin"),
    email: t("channel.email"),
  };
  const relationshipText: Record<SuppressionRelationship, string> = {
    customer: t("relationship.customer"),
    competitor: t("relationship.competitor"),
  };
  /** An opt-out's reason code in words; one general word for any other code. */
  const reasons = new Map([
    ["reply_opt_out", t("reason.reply_opt_out")],
    ["email_unsubscribe", t("reason.email_unsubscribe")],
    ["notice_opt_out", t("reason.notice_opt_out")],
    ["complaint", t("reason.complaint")],
  ]);
  const reasonOf = (code: string) => reasons.get(code) ?? t("reason.other");
  /** The entry's name, else its value, else "Erased person": erasure emptied it. */
  const whoOf = (entry: Entry) =>
    entry.displayName ?? entry.linkedinUrl ?? entry.domain ?? entry.email ?? t("erased");
  const addedBy = ({ source, createdBy }: Entry) => {
    if (source === "system") return t("added_by.system");
    if (viewer === undefined) return null;
    return createdBy === viewer ? t("added_by.you") : t("added_by.teammate");
  };
  const columns: Column<Entry>[] = [
    {
      id: "who",
      header: t("columns.who"),
      cell: (entry) => {
        const value = entry.linkedinUrl ?? entry.domain ?? entry.email;
        // An entry on the hash of the address of a person without a profile has no value, and
        // shows their name (gamma-rf-050); one nobody holds was emptied by erasure.
        if (value === null && entry.displayName === null) {
          return <span className="text-ink-muted">{t("erased")}</span>;
        }
        return (
          <span className="grid min-w-48">
            <span className="break-all">{entry.displayName ?? value}</span>{" "}
            {entry.displayName !== null && value !== null && (
              <span className="break-all text-xs font-normal text-ink-muted">{value}</span>
            )}
          </span>
        );
      },
    },
    {
      id: "kind",
      header: t("columns.kind"),
      cell: (entry) => {
        const kind = kindOf(entry);
        const Icon = KIND_ICONS[kind];
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {kindText[kind]}
          </span>
        );
      },
    },
    {
      id: "list",
      header: t("columns.list"),
      cell: ({ layer, relationship, reason }) => {
        if (layer === "opt_out") {
          return (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <Badge tone="warning">{t("list.opt_out")}</Badge>{" "}
              {reason !== null && (
                <span className="text-xs text-ink-muted">{reasonOf(reason)}</span>
              )}
            </span>
          );
        }
        if (relationship !== null) {
          return <Badge tone="accent">{relationshipText[relationship]}</Badge>;
        }
        return <Badge>{t("list.blocklist")}</Badge>;
      },
    },
    {
      id: "channel",
      header: t("columns.channel"),
      cell: ({ channel }) => <span className="whitespace-nowrap">{channelText[channel]}</span>,
    },
    { id: "added_by", header: t("columns.added_by"), cell: addedBy },
    {
      id: "added",
      header: t("columns.added"),
      cell: ({ createdAt }) => (
        <time dateTime={createdAt} className="whitespace-nowrap">
          {format.dateTime(new Date(createdAt), { dateStyle: "medium" })}
        </time>
      ),
    },
  ];
  if (lifts) {
    columns.push({
      id: "remove",
      header: t("columns.remove"),
      cell: (entry) =>
        entry.layer !== "opt_out" && (
          <Button
            variant="ghost"
            size="sm"
            aria-label={t("remove.label", { who: whoOf(entry) })}
            onClick={() => setRemoving(entry)}
          >
            <Trash2 aria-hidden="true" />
            {t("remove.action")}
          </Button>
        ),
    });
  }
  const added = (layer: Layer) => {
    setToast(layer === "opt_out" ? t("toast.opted_out") : t("toast.added"));
    void read([]);
  };

  let list: ReactNode;
  if (failure !== undefined) {
    list = (
      <div className="grid gap-3">
        <p className="font-medium text-ink">{t("error")}</p>
        <ErrorState module="contacts" code={failure.code} onRetry={() => read(failure.cursors)} />
      </div>
    );
  } else if (shown === undefined) {
    list = <NeverContactLoading />;
  } else {
    const { cursors, next } = shown;
    list = (
      <div
        aria-busy={busy || undefined}
        className="transition-opacity duration-150 aria-busy:opacity-60"
      >
        <DataTable
          caption={t("caption")}
          columns={columns}
          rows={shown.entries}
          pager={{
            onPrevious: cursors.length > 0 ? () => read(cursors.slice(0, -1)) : undefined,
            onNext: next ? () => read([...cursors, next]) : undefined,
          }}
          empty={
            <EmptyState
              message={t("empty")}
              action={
                <ButtonLink href={`/w/${workspace}/leads`}>
                  <Users aria-hidden="true" />
                  {t("empty_link")}
                </ButtonLink>
              }
            />
          }
        />
      </div>
    );
  }

  return (
    <>
      <AddForm workspace={workspace} onAdded={added} />
      <Exclusions
        workspace={workspace}
        viewer={viewer}
        lifts={lifts}
        onChanged={(message) => {
          if (message !== undefined) setToast(message);
          void read([]);
        }}
      />
      {removeFailed !== undefined && (
        <div className="mb-4">
          <ErrorState module="contacts" code={removeFailed} />
        </div>
      )}
      {list}
      <Dialog
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={t("remove.title", { who: removing ? whoOf(removing) : "" })}
        actions={
          <Button variant="danger" onClick={() => removing && remove(removing)}>
            {t("remove.action")}
          </Button>
        }
      >
        <p className="my-3">{t("remove.body")}</p>
      </Dialog>
      <Toast message={toast} />
    </>
  );
}

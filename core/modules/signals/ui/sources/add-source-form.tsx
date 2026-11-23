"use client";
// The add form (README.md "Screen"), a card on top of the screen: the kind, then its fields across (a
// LinkedIn post's URL; a topic's phrase and the roles it keeps, one at least; a competitor's page
// and its name; a creator's profile; none for the own posts), then a label and the sender account,
// from linkedin's accounts of the workspace, the user's own connected one first, beside Add on a wide
// card. A Web research source reads through no account (gamma-wr-030): its fields are what to look
// for, a region, languages and start pages, with no sender account; with no account connected the
// form offers it alone, under the note that LinkedIn kinds need one. The api's refusals show inline: a field off the kind's schema under each field it names
// (signal_config_invalid, signal_topic_blocked), the limits of enabled sources and anything else in
// the form (signal_sources_limit, signal_tracked_limit). Beside the title, once an account exists,
// "Import sources from a CSV" opens the import (source-import.tsx).
import { Button, Checkbox, ErrorState, Link, Select, TextField } from "@whytide/ui";
import { FileUp, Plus, Unplug } from "@whytide/ui/icons";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useState } from "react";
import { COMPANY_NAME_MAX_CHARS } from "../../sources/competitor_engagement/constants.ts";
import { ACCOUNTLESS, FIELDS, KINDS, type Kind, ROLES } from "./constants.ts";
import { configOf, EMPTY_RESEARCH, ResearchFields } from "./research-fields.tsx";
import type { Account } from "./source-list.tsx";

/** A refusal of the kind's fields: its code, and the fields it names that the form shows. */
type Refusal = { readonly code: string; readonly fields: readonly string[] };

/**
 * The account the form starts on, and the import: the user's own connected one, else any connected,
 * else the first.
 */
export function firstChoice(accounts: Account[]): string {
  const connected = accounts.filter(({ status }) => status === "connected");
  return (connected.find(({ mine }) => mine) ?? connected[0] ?? accounts[0])?.id ?? "";
}

export function AddSourceForm({
  workspaceId,
  accounts,
  onAdded,
  onImport,
}: {
  workspaceId: string;
  accounts: Account[];
  /** Reads the screen again, once the source is saved. */
  onAdded: () => Promise<void>;
  /** Opens the import of a CSV file of sources. */
  onImport: () => void;
}) {
  const t = useTranslations("signals");
  /** The kinds the form adds: with no account connected, those that read through none. */
  const offered: readonly Kind[] = accounts.length === 0 ? ACCOUNTLESS : KINDS;
  const [chosen, setKind] = useState<Kind>(offered[0] ?? "post_engagers");
  const kind = offered.includes(chosen) ? chosen : (offered[0] ?? chosen);
  const accountless = ACCOUNTLESS.includes(kind);
  const [research, setResearch] = useState(EMPTY_RESEARCH);
  const [postUrl, setPostUrl] = useState("");
  const [phrase, setPhrase] = useState("");
  const [roles, setRoles] = useState<string[]>([...ROLES]);
  const [companyUrl, setCompanyUrl] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [profileUrl, setProfileUrl] = useState("");
  const [label, setLabel] = useState("");
  const [account, setAccount] = useState(() => firstChoice(accounts));
  const [busy, setBusy] = useState(false);
  /** The refusal of the kind's fields: signal_config_invalid or signal_topic_blocked. */
  const [refused, setRefused] = useState<Refusal>();
  const [failure, setFailure] = useState<string>();
  const kinds: Record<Kind, string> = {
    post_engagers: t("kinds.post_engagers.label"),
    topic_engagement: t("kinds.topic_engagement.label"),
    competitor_engagement: t("kinds.competitor_engagement.label"),
    creator_engagement: t("kinds.creator_engagement.label"),
    my_post_engagement: t("kinds.my_post_engagement.label"),
    web_research: t("kinds.web_research.label"),
  };
  const roleLabels: Record<(typeof ROLES)[number], string> = {
    author: t("sources.role_author"),
    commenter: t("sources.role_commenter"),
    reactor: t("sources.role_reactor"),
  };
  /** The refusal under the field at `path`, when it names that field. */
  const fieldError = (path: string) => {
    if (!refused?.fields.includes(path)) return undefined;
    return refused.code === "signal_topic_blocked"
      ? t("errors.signal_topic_blocked")
      : t("errors.signal_config_invalid");
  };

  /** A refusal: under each field shown that it names, else its code in the form. */
  function refuse(status: number, error: unknown) {
    const { code } = new ApiError(status, error);
    const named = (error as { details?: { fields?: unknown } } | undefined)?.details?.fields;
    const shown = FIELDS[kind];
    const fields = Array.isArray(named)
      ? named.filter((field): field is string => typeof field === "string" && shown.includes(field))
      : [];
    const ofFields = code === "signal_config_invalid" || code === "signal_topic_blocked";
    if (ofFields && fields.length > 0) setRefused({ code, fields });
    else setFailure(code);
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setRefused(undefined);
    setFailure(undefined);
    try {
      const configs: Record<Kind, Record<string, unknown>> = {
        post_engagers: { postUrl },
        topic_engagement: { phrase, roles },
        competitor_engagement: { companyUrl, companyName },
        creator_engagement: { profileUrl },
        my_post_engagement: {},
        web_research: configOf(research),
      };
      const config = configs[kind];
      const body = accountless
        ? { kind, config, label }
        : { kind, config, label, senderAccountId: account };
      const { error, response } = await browserApi().POST(
        "/v1/workspaces/{workspaceId}/signals/sources",
        { params: { path: { workspaceId } }, body },
      );
      if (!response.ok) return refuse(response.status, error);
      setPostUrl("");
      setPhrase("");
      setCompanyUrl("");
      setCompanyName("");
      setProfileUrl("");
      setResearch(EMPTY_RESEARCH);
      setLabel("");
      await onAdded();
    } catch {
      setFailure("internal_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="signals-sources-add"
      className="@container grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="signals-sources-add" className="font-semibold text-ink">
          {t("sources.add_title")}
        </h2>
        {accounts.length === 0 ? null : (
          <Button size="sm" onClick={onImport}>
            <FileUp aria-hidden="true" />
            {t("sources.import_csv")}
          </Button>
        )}
      </header>
      {accounts.length === 0 ? (
        <div className="flex items-start gap-3 rounded-lg bg-muted px-4 py-3">
          <Unplug aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          <p className="text-pretty text-ink-muted">
            {t("sources.no_account")}{" "}
            <Link href={`/w/${workspaceId}/linkedin`}>{t("sources.connect_account")}</Link>
          </p>
        </div>
      ) : null}
      {offered.length === 0 ? null : (
        <form
          onSubmit={add}
          aria-labelledby="signals-sources-add"
          className="grid gap-4 [&_.wt-field]:min-w-0"
        >
          <Select
            label={t("sources.kind")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as Kind);
              setRefused(undefined);
            }}
            options={offered.map((value) => ({ value, label: kinds[value] }))}
          />
          {kind === "post_engagers" ? (
            <TextField
              label={t("sources.post_url")}
              hint={t("sources.post_url_hint")}
              error={fieldError("config.postUrl")}
              type="url"
              required
              value={postUrl}
              onChange={(event) => setPostUrl(event.target.value)}
            />
          ) : null}
          {kind === "topic_engagement" ? (
            <>
              <TextField
                label={t("sources.phrase")}
                hint={t("sources.phrase_hint")}
                error={fieldError("config.phrase")}
                required
                maxLength={100}
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
              />
              <fieldset className="grid gap-2">
                <legend className="mb-2 text-sm font-medium text-ink">{t("sources.roles")}</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {ROLES.map((role) => (
                    <Checkbox
                      key={role}
                      label={roleLabels[role]}
                      checked={roles.includes(role)}
                      // The last role kept stays: a topic keeps one at least.
                      disabled={roles.length === 1 && roles.includes(role)}
                      onChange={(event) =>
                        setRoles(
                          ROLES.filter((r) =>
                            r === role ? event.target.checked : roles.includes(r),
                          ),
                        )
                      }
                    />
                  ))}
                </div>
              </fieldset>
            </>
          ) : null}
          {kind === "competitor_engagement" ? (
            <div className="grid gap-4 @2xl:grid-cols-2">
              <TextField
                label={t("sources.company_url")}
                hint={t("sources.company_url_hint")}
                error={fieldError("config.companyUrl")}
                type="url"
                required
                value={companyUrl}
                onChange={(event) => setCompanyUrl(event.target.value)}
              />
              <TextField
                label={t("sources.company_name")}
                hint={t("sources.company_name_hint")}
                error={fieldError("config.companyName")}
                required
                maxLength={COMPANY_NAME_MAX_CHARS}
                value={companyName}
                onChange={(event) => setCompanyName(event.target.value)}
              />
            </div>
          ) : null}
          {kind === "creator_engagement" ? (
            <TextField
              label={t("sources.profile_url")}
              hint={t("sources.profile_url_hint")}
              error={fieldError("config.profileUrl")}
              type="url"
              required
              value={profileUrl}
              onChange={(event) => setProfileUrl(event.target.value)}
            />
          ) : null}
          {kind === "web_research" ? (
            <ResearchFields value={research} onChange={setResearch} errorOf={fieldError} />
          ) : null}
          <div
            className={`grid items-end gap-4 ${accountless ? "@2xl:grid-cols-[minmax(0,1fr)_auto]" : "@2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"}`}
          >
            <TextField
              label={t("sources.label")}
              required
              maxLength={100}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            {accountless ? null : (
              <Select
                label={t("sources.account")}
                value={account}
                onChange={(event) => setAccount(event.target.value)}
                options={accounts.map(({ id, label: name }) => ({ value: id, label: name }))}
              />
            )}
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

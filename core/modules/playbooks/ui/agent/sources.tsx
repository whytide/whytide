"use client";
// The agent's sources (README "Screens"): signals' sources of the workspace, read in the browser
// through the web's api client, then playbooks' check of their ids, MAX_CHECKED_SOURCES a call. Only
// usable sources are offered, each with the kit's Checkbox, the agent's own checked, at most `max`,
// the list's limits.sources; a source another agent holds shows off, with that agent's name; one read
// through another member's account, or not found, is left out. Save puts the set, the usable ones
// checked. With no source checker registered (503 playbook_source_checker_missing, for no id too)
// the card says that sources cannot be linked yet; with nothing to offer, it leads to the Sources
// screen. Read-only, for a visitor who may not change the agent, the boxes are off and Save is gone.
import {
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Link,
  LoadingState,
  useErrorText,
} from "@whytide/ui";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { MAX_CHECKED_SOURCES } from "../../domain/constants.ts";
import type { PlaybookListResponse } from "../../schemas/playbooks.ts";
import {
  CHECK_PATH,
  SIGNAL_SOURCES_PATH,
  SOURCE_CODES_SHOWN,
  SOURCES_PATH,
  sourcesScreen,
} from "../constants.ts";

type Props = {
  workspace: string;
  playbookId: string;
  /** The agent's sources as the api last answered them. */
  initial: readonly string[];
  /** The workspace's agents, by which a source another agent holds is named. */
  playbooks: PlaybookListResponse["playbooks"];
  /** The most sources the agent holds, as the api is configured (the list's limits.sources). */
  max: number;
  /** Another member's agent, for a visitor without playbooks.manage: shown, never changed. */
  readOnly?: boolean;
};
/** A source the card shows: usable, or held by another agent, `heldBy` its id. */
type Offered = { readonly id: string; readonly label: string; readonly heldBy: string | null };

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");
const { checkerMissing, inUse } = SOURCE_CODES_SHOWN;

/** The ids in batches the check takes; one empty batch for none, which still says if it can link. */
function batches(ids: readonly string[]): string[][] {
  const count = Math.max(1, Math.ceil(ids.length / MAX_CHECKED_SOURCES));
  return Array.from({ length: count }, (_, at) =>
    ids.slice(at * MAX_CHECKED_SOURCES, (at + 1) * MAX_CHECKED_SOURCES),
  );
}

export function Sources({ workspace, playbookId, initial, playbooks, max, readOnly }: Props) {
  const t = useTranslations("playbooks.sources");
  const missing = useErrorText("playbooks", checkerMissing);
  /** Undefined while it loads. */
  const [offered, setOffered] = useState<Offered[]>();
  /** The read that failed. */
  const [failure, setFailure] = useState<string>();
  const [saved, setSaved] = useState<readonly string[]>(initial);
  const [chosen, setChosen] = useState(() => new Set(initial));
  const [busy, setBusy] = useState(false);
  /** The save the api refused. */
  const [refusal, setRefusal] = useState<string>();
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    setFailure(undefined);
    try {
      const path = { workspaceId: workspace };
      const read = browserApi().GET(SIGNAL_SOURCES_PATH, { params: { path } });
      const { sources } = await data(read);
      const checkPath = { path: { workspaceId: workspace, playbookId } };
      const checks = batches(sources.map(({ id }) => id)).map((ids) => {
        const query = ids.length === 0 ? {} : { query: { ids: ids.join(",") } };
        return data(browserApi().GET(CHECK_PATH, { params: { ...checkPath, ...query } }));
      });
      const uses = (await Promise.all(checks)).flatMap((answer) => answer.sources);
      const useOf = new Map(uses.map((use) => [use.sourceId, use]));
      setOffered(
        sources.flatMap(({ id, label }): Offered[] => {
          const use = useOf.get(id);
          if (use?.usable) return [{ id, label, heldBy: null }];
          const heldBy = use?.code === inUse ? use.heldBy : null;
          return heldBy === null ? [] : [{ id, label, heldBy }];
        }),
      );
    } catch (error) {
      setFailure(codeOf(error));
    }
  }, [workspace, playbookId]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = (body: ReactNode) => (
    <Card title={t("title")} description={t("description", { max })}>
      {body}
    </Card>
  );
  if (failure === checkerMissing) return card(<p className="text-ink-muted">{missing}</p>);
  if (failure !== undefined) {
    return card(<ErrorState module="playbooks" code={failure} onRetry={load} />);
  }
  if (offered === undefined) return card(<LoadingState />);
  if (offered.length === 0) {
    const open = <Link href={sourcesScreen(workspace)}>{t("open")}</Link>;
    return card(<EmptyState message={t("empty")} action={open} />);
  }

  // The usable ones checked: a link that is no longer usable leaves with the next save.
  const set = offered.flatMap(({ id, heldBy }) => (heldBy === null && chosen.has(id) ? [id] : []));
  const full = set.length >= max;
  const changed = set.length !== saved.length || set.some((id) => !saved.includes(id));
  const holder = (heldBy: string) => {
    const agent = playbooks.find(({ id }) => id === heldBy);
    return agent === undefined ? t("held_by_other") : t("held_by", { agent: agent.name });
  };
  const toggle = (id: string, on: boolean) => {
    setDone(false);
    setChosen((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  async function save() {
    setBusy(true);
    setRefusal(undefined);
    setDone(false);
    try {
      const params = { path: { workspaceId: workspace, playbookId } };
      const body = { sourceIds: set };
      const answer = await data(browserApi().PUT(SOURCES_PATH, { params, body }));
      setSaved(answer.sourceIds);
      setChosen(new Set(answer.sourceIds));
      setDone(true);
    } catch (error) {
      setRefusal(codeOf(error));
    }
    setBusy(false);
  }

  return card(
    <>
      <ul className="grid gap-3 sm:grid-cols-2">
        {offered.map(({ id, label, heldBy }) => {
          const checked = heldBy === null && chosen.has(id);
          return (
            <li key={id}>
              <Checkbox
                label={label}
                checked={checked}
                disabled={readOnly || busy || heldBy !== null || (full && !checked)}
                hint={heldBy === null ? undefined : holder(heldBy)}
                onChange={(event) => toggle(id, event.target.checked)}
              />
            </li>
          );
        })}
      </ul>
      <p className="text-sm text-ink-muted">{t("chosen", { count: set.length, max })}</p>
      {full ? <p className="text-sm text-ink-muted">{t("full")}</p> : null}
      {refusal === undefined ? null : <ErrorState module="playbooks" code={refusal} />}
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={busy} disabled={!changed} onClick={save}>
            {t("save")}
          </Button>
          <p role="status" className="text-sm text-ink-muted">
            {done ? t("saved") : null}
          </p>
        </div>
      )}
    </>,
  );
}

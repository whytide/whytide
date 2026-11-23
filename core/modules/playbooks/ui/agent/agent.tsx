"use client";
// The agent's page in the browser (README "Screens"): the way back to the list; the header with the
// agent's name, its status and its audience, Pause or Resume, and Archive, which asks first in the
// kit's Dialog; the name and the audience, saved together, the audience one of the agent's own and
// those no other live agent has; its sources (sources.tsx); then the slots' panels. Each change is
// the agent's PATCH, whose answer the page then shows; a code the api answers shows in words. An
// archived agent says that it no longer changes, with no button, form or picker. Another member's
// agent, for a member without playbooks.manage, shows its settings and sources disabled under a
// hint, with no button (README "Decided here"). An agent paused because its owner left the
// workspace says so, and offers Resume to that owner alone, as the api decides (gamma-p6-075).
import {
  Button,
  ButtonLink,
  Card,
  Dialog,
  ErrorState,
  Link,
  PageHeader,
  Select,
  TextField,
} from "@whytide/ui";
import { Archive, ArrowLeft, Pause, Play } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";
import { PLAYBOOK_NAME_MAX } from "../../domain/constants.ts";
import type {
  PlaybookListResponse,
  PlaybookResponse,
  UpdatePlaybookBody,
} from "../../schemas/playbooks.ts";
import { type Audience, isLive, isOwnerRemoved, StatusBadge, useAudienceName } from "../common.tsx";
import { agentsScreen, icpScreen, PLAYBOOK_PATH } from "../constants.ts";
import { Sources } from "./sources.tsx";

type Props = {
  workspace: string;
  initial: PlaybookResponse;
  audiences: readonly Audience[];
  playbooks: PlaybookListResponse["playbooks"];
  /** The limits the api answers with the list: the sources' for the picker. */
  limits: PlaybookListResponse["limits"];
  /** Whether the visitor may change it: its owner, or a holder of playbooks.manage. */
  writable: boolean;
  /** Whether the visitor is its owner, who alone resumes it once paused because they left. */
  owned: boolean;
  /** The slots' panels, rendered on the server. */
  children?: ReactNode;
};
/** What a change is on: the name and the audience, or the status. */
type Busy = "settings" | "status";

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export function Agent(props: Props) {
  const { workspace, initial, audiences, playbooks, limits, writable, owned, children } = props;
  const t = useTranslations("playbooks.agent");
  const refusals = useTranslations("playbooks.errors");
  const list = useTranslations("playbooks.list");
  const save = useTranslations("ui.action");
  const audienceName = useAudienceName(audiences);
  const [agent, setAgent] = useState(initial);
  const [name, setName] = useState(initial.name);
  const [icpId, setIcpId] = useState(initial.icpId);
  const [busy, setBusy] = useState<Busy>();
  const [failure, setFailure] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const archived = agent.status === "archived";
  const ownerRemoved = isOwnerRemoved(agent);
  const taken = playbooks.filter((other) => other.id !== agent.id && isLive(other));
  const options = audiences
    .filter(({ id }) => !taken.some((other) => other.icpId === id))
    .map(({ id }) => ({ value: id, label: audienceName(id) }));
  const changed = name.trim() !== agent.name || icpId !== agent.icpId;

  async function change(body: UpdatePlaybookBody, what: Busy) {
    setBusy(what);
    setFailure(undefined);
    setSaved(false);
    try {
      const params = { path: { workspaceId: workspace, playbookId: agent.id } };
      const answer = await data(browserApi().PATCH(PLAYBOOK_PATH, { params, body }));
      setAgent(answer);
      setName(answer.name);
      setIcpId(answer.icpId);
      setSaved(what === "settings");
    } catch (error) {
      setFailure(codeOf(error));
    }
    setBusy(undefined);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (changed && name.trim() !== "") void change({ name: name.trim(), icpId }, "settings");
  }

  const status = agent.status === "active" ? "paused" : "active";
  const actions =
    archived || !writable ? undefined : (
      <>
        {ownerRemoved && !owned ? null : (
          <Button
            loading={busy === "status"}
            disabled={busy === "settings"}
            onClick={() => change({ status }, "status")}
          >
            {status === "paused" ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
            {status === "paused" ? t("pause") : t("resume")}
          </Button>
        )}
        <Button variant="danger" disabled={busy !== undefined} onClick={() => setArchiving(true)}>
          <Archive aria-hidden="true" />
          {t("archive")}
        </Button>
      </>
    );

  return (
    <>
      <title>{agent.name}</title>
      <div className="-ms-2.5 -mt-2 mb-5">
        <ButtonLink href={agentsScreen(workspace)} variant="ghost" size="sm">
          <ArrowLeft aria-hidden="true" className="rtl:-scale-x-100" />
          {t("back")}
        </ButtonLink>
      </div>
      <PageHeader
        title={agent.name}
        meta={
          <>
            <StatusBadge status={agent.status} pausedReason={agent.pausedReason} />
            <span className="text-sm text-ink-muted">{audienceName(agent.icpId)}</span>
          </>
        }
        actions={actions}
      />
      <div className="grid gap-6">
        {failure === undefined ? null : <ErrorState module="playbooks" code={failure} />}
        {archived ? (
          <p className="text-pretty text-ink-muted">{t("archived")}</p>
        ) : (
          <>
            {writable ? null : <p className="text-pretty text-ink-muted">{t("not_owner")}</p>}
            {ownerRemoved && !owned ? (
              <p className="text-pretty text-ink-muted">{refusals("playbook_owner_removed")}</p>
            ) : null}
            <Card title={t("settings")}>
              <form className="grid gap-4" onSubmit={submit}>
                <div className="grid gap-4 sm:grid-cols-2 [&_.wt-field]:min-w-0">
                  <TextField
                    label={t("name")}
                    value={name}
                    maxLength={PLAYBOOK_NAME_MAX}
                    required
                    disabled={!writable}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <Select
                    label={t("audience")}
                    value={icpId}
                    options={options}
                    disabled={!writable}
                    onChange={(event) => setIcpId(event.target.value)}
                  />
                </div>
                <p>
                  <Link href={icpScreen(workspace)}>{list("icp_link")}</Link>
                </p>
                {writable ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="submit"
                      variant="primary"
                      loading={busy === "settings"}
                      disabled={!changed || name.trim() === "" || busy === "status"}
                    >
                      {save("save")}
                    </Button>
                    <p role="status" className="text-sm text-ink-muted">
                      {saved ? t("saved") : null}
                    </p>
                  </div>
                ) : null}
              </form>
            </Card>
            <Sources
              workspace={workspace}
              playbookId={agent.id}
              initial={agent.sourceIds}
              playbooks={playbooks}
              max={limits.sources}
              readOnly={!writable}
            />
          </>
        )}
        {children}
      </div>
      <Dialog
        open={archiving}
        onClose={() => setArchiving(false)}
        title={t("archive_title")}
        actions={
          <Button
            variant="danger"
            onClick={() => {
              setArchiving(false);
              void change({ status: "archived" }, "status");
            }}
          >
            <Archive aria-hidden="true" />
            {t("archive")}
          </Button>
        }
      >
        <p>{t("archive_body")}</p>
      </Dialog>
    </>
  );
}

"use client";
// New agent (README "Screens"), in the list's header: the kit's Dialog with the agent's name and its
// audience, the kit's Select of the workspace's audiences that no live agent has, and the way to the
// ICP screen, where another audience is made. Create posts the agent with an Idempotency-Key, which
// the same body sent again after a failure reuses, then opens its page; a code the api answers shows
// in words in the dialog. With the list's limits.agents live agents the button is off, the limit
// said beside it.
import { Button, Dialog, ErrorState, Link, Select, TextField } from "@whytide/ui";
import { Plus } from "@whytide/ui/icons";
import { ApiError, browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useRef, useState } from "react";
import { PLAYBOOK_NAME_MAX } from "../../domain/constants.ts";
import type { PlaybookListResponse } from "../../schemas/playbooks.ts";
import { type Audience, isLive, useAudienceName } from "../common.tsx";
import { agentScreen, icpScreen, PLAYBOOKS_PATH } from "../constants.ts";

type Props = {
  workspace: string;
  playbooks: PlaybookListResponse["playbooks"];
  /** The limits the api answers with the list. */
  limits: PlaybookListResponse["limits"];
  audiences: readonly Audience[];
};

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : "internal_error");

export function NewAgent({ workspace, playbooks, limits, audiences }: Props) {
  const t = useTranslations("playbooks.list");
  const field = useTranslations("playbooks.agent");
  const audienceName = useAudienceName(audiences);
  const form = useId();
  const limit = useId();
  const live = playbooks.filter(isLive);
  const free = audiences.filter(({ id }) => !live.some((agent) => agent.icpId === id));
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [icpId, setIcpId] = useState(free[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  /** The last body that failed, as sent, and its key, which the same body sent again reuses. */
  const last = useRef<{ sent: string; key: string }>(undefined);
  const full = live.length >= limits.agents;
  const body = { name: name.trim(), icpId };
  const ready = body.name !== "" && body.icpId !== "";

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !ready) return;
    const sent = JSON.stringify(body);
    const key = last.current?.sent === sent ? last.current.key : crypto.randomUUID();
    setBusy(true);
    setFailure(undefined);
    try {
      const params = { path: { workspaceId: workspace }, header: { "Idempotency-Key": key } };
      const created = await data(browserApi().POST(PLAYBOOKS_PATH, { params, body }));
      window.location.assign(agentScreen(workspace, created.id));
    } catch (error) {
      last.current = { sent, key };
      setFailure(codeOf(error));
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        variant="primary"
        disabled={full}
        aria-describedby={full ? limit : undefined}
        onClick={() => setAsking(true)}
      >
        <Plus aria-hidden="true" />
        {t("new")}
      </Button>
      {full ? (
        <p id={limit} className="max-w-xs text-pretty text-xs text-ink-muted">
          {t("limit", { max: limits.agents })}
        </p>
      ) : null}
      <Dialog
        open={asking}
        onClose={() => {
          setAsking(false);
          setFailure(undefined);
        }}
        title={t("new")}
        actions={
          <Button type="submit" form={form} variant="primary" loading={busy} disabled={!ready}>
            {t("create")}
          </Button>
        }
      >
        <form id={form} className="grid gap-4 [&_.wt-field]:min-w-0" onSubmit={create}>
          <TextField
            label={field("name")}
            value={name}
            maxLength={PLAYBOOK_NAME_MAX}
            required
            onChange={(event) => setName(event.target.value)}
          />
          {free.length > 0 ? (
            <Select
              label={field("audience")}
              value={icpId}
              options={free.map(({ id }) => ({ value: id, label: audienceName(id) }))}
              onChange={(event) => setIcpId(event.target.value)}
            />
          ) : (
            <p>{t("no_audience")}</p>
          )}
          <p>
            <Link href={icpScreen(workspace)}>{t("icp_link")}</Link>
          </p>
          {failure === undefined ? null : <ErrorState module="playbooks" code={failure} />}
        </form>
      </Dialog>
    </>
  );
}

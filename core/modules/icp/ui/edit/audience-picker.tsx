// The audience picker (README "The screen"), a client component under the ICP screen's header: the
// kit's Select of the workspace's audiences, the default first and marked, which opens the one
// chosen at `?audience=<icpId>`; and New audience, which asks for a name in the kit's Dialog, creates
// the audience through the api, with the six default criteria, and opens it. At the workspace's
// limit, the one the audiences' list answers, the button is off and the line beside it says why; a
// code the api answers shows in words in the dialog.
"use client";

import { Button, Dialog, ErrorState, Select, TextField } from "@whytide/ui";
import { Plus } from "@whytide/ui/icons";
import { browserApi, data } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { AUDIENCE_NAME_MAX } from "../../domain/constants.ts";
import type { AudienceResponse, AudiencesResponse } from "../../schemas/icp.ts";
import { AUDIENCES_PATH, audienceHref } from "./constants.ts";

type Props = {
  workspace: string;
  /** The workspace's audiences as the api lists them, the default first. */
  audiences: readonly AudienceResponse[];
  /** The limits the api answers with the list, as it is configured. */
  limits: AudiencesResponse["limits"];
  /** The audience the screen shows. */
  chosen: string;
};

/** The code of a failed call, an ApiError's; else internal_error (no answer: the network). */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : "internal_error";
}

export function AudiencePicker({ workspace, audiences, limits, chosen }: Props) {
  const t = useTranslations("icp.screen");
  const form = useId();
  const limit = useId();
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const full = audiences.length >= limits.audiences;
  const blank = name.trim() === "";
  /** The default by its name, else the screen's, and marked; another without a name says so. */
  const options = audiences.map(({ id, name: given, isDefault }) => ({
    value: id,
    label: isDefault
      ? t("default_badge", { name: given || t("default_name") })
      : given || t("unnamed_audience"),
  }));

  /** Creates the audience and opens it; the page loads it as any other. */
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (blank) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const params = { path: { workspaceId: workspace } };
      const body = { name: name.trim() };
      const created = await data(browserApi().POST(AUDIENCES_PATH, { params, body }));
      window.location.assign(audienceHref(created.id));
    } catch (error) {
      setFailure(codeOf(error));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 pb-6">
      <div className="w-full sm:w-80 [&_.wt-field]:min-w-0">
        <Select
          label={t("audience_label")}
          defaultValue={chosen}
          options={options}
          onChange={(event) => window.location.assign(audienceHref(event.target.value))}
        />
      </div>
      <Button
        disabled={full}
        aria-describedby={full ? limit : undefined}
        onClick={() => setAsking(true)}
      >
        <Plus aria-hidden="true" />
        {t("new_audience")}
      </Button>
      {full ? (
        <p id={limit} className="text-pretty text-xs text-ink-muted sm:self-center">
          {t("audience_limit", { max: limits.audiences })}
        </p>
      ) : null}
      <Dialog
        open={asking}
        onClose={() => {
          setAsking(false);
          setFailure(undefined);
        }}
        title={t("new_audience")}
        actions={
          <Button type="submit" form={form} variant="primary" loading={busy} disabled={blank}>
            {t("create_audience")}
          </Button>
        }
      >
        <form id={form} className="grid gap-4" onSubmit={create}>
          <TextField
            label={t("new_audience_name")}
            value={name}
            maxLength={AUDIENCE_NAME_MAX}
            required
            onChange={(event) => setName(event.target.value)}
          />
          {failure === undefined ? null : <ErrorState module="icp" code={failure} />}
        </form>
      </Dialog>
    </div>
  );
}

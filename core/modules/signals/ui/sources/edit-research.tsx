"use client";
// Edit, on a Web research source's card (README.md "Screen"; gamma-wr-030): the add form's fields in a
// dialog, saved with PATCH …/signals/sources/{id} and its `config`. A refusal of a field shows under
// it, any other in the dialog. The kind's schema reads the fields again, so a refusal names the same
// ones as the create's.
import { Button, Dialog, ErrorState } from "@whytide/ui";
import { ApiError, browserApi } from "@whytide/web/api/browser";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FIELDS } from "./constants.ts";
import { configOf, ResearchFields, researchOf } from "./research-fields.tsx";
import type { Source } from "./source-list.tsx";

export function EditResearch(props: {
  workspaceId: string;
  source: Source;
  onClose: () => void;
  /** The fields are saved: reads the screen again. */
  onSaved: () => Promise<void>;
}) {
  const { workspaceId, source, onClose, onSaved } = props;
  const t = useTranslations("signals");
  const [typed, setTyped] = useState(() => researchOf(source.config));
  const [busy, setBusy] = useState(false);
  const [named, setNamed] = useState<readonly string[]>([]);
  const [failure, setFailure] = useState<string>();

  async function save() {
    setBusy(true);
    setNamed([]);
    setFailure(undefined);
    try {
      const path = { workspaceId, id: source.id };
      const { error, response } = await browserApi().PATCH(
        "/v1/workspaces/{workspaceId}/signals/sources/{id}",
        { params: { path }, body: { config: configOf(typed) } },
      );
      if (!response.ok) {
        const { code } = new ApiError(response.status, error);
        const fields = (error as { details?: { fields?: unknown } } | undefined)?.details?.fields;
        const shown = Array.isArray(fields)
          ? fields.filter(
              (f): f is string => typeof f === "string" && FIELDS.web_research.includes(f),
            )
          : [];
        if (code === "signal_config_invalid" && shown.length > 0) setNamed(shown);
        else setFailure(code);
        return;
      }
      await onSaved();
      onClose();
    } catch {
      setFailure("internal_error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("sources.edit_title", { label: source.label })}
      actions={
        <Button variant="primary" loading={busy} onClick={save}>
          {t("sources.save")}
        </Button>
      }
    >
      <div className="my-3 grid gap-4 [&_.wt-field]:min-w-0">
        <ResearchFields
          value={typed}
          onChange={setTyped}
          errorOf={(path) => (named.includes(path) ? t("errors.signal_config_invalid") : undefined)}
        />
        {failure ? <ErrorState module="signals" code={failure} /> : null}
      </div>
    </Dialog>
  );
}

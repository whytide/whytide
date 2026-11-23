// The lead page's Edit (header.tsx; README.md "Screens", lead-fields-edit): a button in the header's
// actions that opens a dialog with the person's six profile fields, Save and Cancel. Save sends the
// fields the member changed, trimmed, as PATCH …/contacts/leads/{personId}, then reads the page again
// (router.refresh()), whose new values show with their Edited mark when the dialog closes; a toast
// says so. A refusal shows its code in words under each field it names (`details.fields`), else
// above the fields. The edit changes no score: the page's Re-score asks for a new judgement.
// The six fields are person-fields.tsx's, which Add lead on the Leads screen shares.
"use client";

import { Button, Dialog, Toast, useErrorText } from "@whytide/ui";
import { Pencil } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState, useTransition } from "react";
import { EDITABLE_FIELDS } from "../../domain/constants.ts";
import { useToast } from "../never-contact/block.tsx";
import type { Lead } from "./page.tsx";
import { type FieldValues, PersonFields, type Refusal, refusalOf } from "./person-fields.tsx";

/** The person's six fields as the form holds them: an empty string for none. */
const valuesOf = (person: Lead["person"]): FieldValues =>
  Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, person[field] ?? ""])) as FieldValues;

export function EditLead({ workspace, lead }: { workspace: string; lead: Lead }) {
  const t = useTranslations("contacts.lead_edit");
  const action = useTranslations("ui.action");
  const router = useRouter();
  const form = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<FieldValues>(() => valuesOf(lead.person));
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [refusal, setRefusal] = useState<Refusal>();
  const [toast, setToast] = useToast();
  const words = useErrorText("contacts", refusal?.code ?? "internal_error");
  const named = EDITABLE_FIELDS.filter((field) => refusal?.fields.includes(field));

  function start() {
    setValues(valuesOf(lead.person));
    setRefusal(undefined);
    setOpen(true);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || refreshing) return;
    const stored = valuesOf(lead.person);
    // Only what changed: a field sent takes the member's stamp, which no source overwrites.
    const body = Object.fromEntries(
      EDITABLE_FIELDS.flatMap((field) => {
        const value = values[field].trim();
        return value === stored[field] ? [] : [[field, value]];
      }),
    );
    if (Object.keys(body).length === 0) return setOpen(false);
    setSaving(true);
    setRefusal(undefined);
    try {
      const path = { workspaceId: workspace, personId: lead.personId };
      const answer = await browserApi().PATCH(
        "/v1/workspaces/{workspaceId}/contacts/leads/{personId}",
        { params: { path }, body },
      );
      if (!answer.response.ok) return setRefusal(refusalOf(answer.error));
      startRefresh(() => {
        router.refresh();
        setOpen(false);
        setToast(t("saved"));
      });
    } catch {
      setRefusal(refusalOf(undefined));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="ghost" onClick={start}>
        <Pencil aria-hidden="true" />
        {t("action")}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("title")}
        actions={
          <Button type="submit" form={form} variant="primary" loading={saving || refreshing}>
            {action("save")}
          </Button>
        }
      >
        <p>{t("hint")}</p>
        {refusal && named.length === 0 && (
          <p role="alert" className="text-danger-ink">
            {words}
          </p>
        )}
        {/* The fields scroll inside the dialog on a short screen, its buttons in view. */}
        <form
          id={form}
          onSubmit={save}
          className="-mx-1 mt-2 grid max-h-[55dvh] gap-4 overflow-y-auto px-1 pb-1"
          noValidate
        >
          <PersonFields
            values={values}
            onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
            errorOf={(field) => (named.includes(field) ? words : undefined)}
          />
        </form>
      </Dialog>
      <Toast message={toast} />
    </>
  );
}

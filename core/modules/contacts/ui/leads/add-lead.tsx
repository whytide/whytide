// The Leads screen's Add lead (list.tsx; README.md "Screens", lead-manual-create): a button, in the
// header's actions and in the empty state, that opens a dialog with the LinkedIn profile URL and
// the person's six profile fields (../lead/person-fields.tsx), the URL and the first name required,
// Add and Cancel. Add sends POST …/contacts/leads with the fields filled in, trimmed, and stays
// busy, the dialog open, until the browser is on the new lead's page, where the lead is pending
// until qualification's next batch scores it. A refusal shows its code in words under the field at
// fault: the URL's for linkedin_url_invalid, person_erased and lead_exists, which links to the lead
// the person has; the fields `details.fields` names for contacts_input_invalid; else above the
// fields.
"use client";

import { Button, Dialog, Link, TextField, useErrorText } from "@whytide/ui";
import { UserPlus } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState, useTransition } from "react";
import { EDITABLE_FIELDS } from "../../domain/constants.ts";
import { type FieldValues, PersonFields, type Refusal, refusalOf } from "../lead/person-fields.tsx";
import { URL_CODES } from "./constants.ts";

const NO_VALUES = Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, ""])) as FieldValues;

/** What Add sends: the URL and the first name as typed, trimmed, and the other fields filled in. */
function bodyOf(url: string, values: FieldValues) {
  const filled = EDITABLE_FIELDS.flatMap((field) => {
    const value = values[field].trim();
    return value === "" && field !== "firstName" ? [] : [[field, value] as const];
  });
  return { linkedinUrl: url.trim(), ...Object.fromEntries(filled) };
}

export function AddLead({ workspace }: { workspace: string }) {
  const t = useTranslations("contacts.lead_add");
  const router = useRouter();
  const form = useId();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [values, setValues] = useState(NO_VALUES);
  const [saving, setSaving] = useState(false);
  const [going, startGoing] = useTransition();
  const [refusal, setRefusal] = useState<Refusal>();
  const words = useErrorText("contacts", refusal?.code ?? "internal_error");
  const onUrl = refusal !== undefined && URL_CODES.includes(refusal.code);
  const named = EDITABLE_FIELDS.filter((field) => refusal?.fields.includes(field));
  const existing = refusal?.code === "lead_exists" ? refusal.personId : undefined;
  const leadPage = (personId: string) => `/w/${workspace}/leads/${encodeURIComponent(personId)}`;

  function start() {
    setUrl("");
    setValues(NO_VALUES);
    setRefusal(undefined);
    setOpen(true);
  }

  async function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || going) return;
    setSaving(true);
    setRefusal(undefined);
    try {
      const answer = await browserApi().POST("/v1/workspaces/{workspaceId}/contacts/leads", {
        params: { path: { workspaceId: workspace } },
        body: bodyOf(url, values),
      });
      if (!answer.response.ok || answer.data === undefined) {
        return setRefusal(refusalOf(answer.error));
      }
      const { personId } = answer.data;
      // Add stays busy, the dialog open, until the lead's page replaces the list.
      startGoing(() => router.push(leadPage(personId)));
    } catch {
      setRefusal(refusalOf(undefined));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button onClick={start}>
        <UserPlus aria-hidden="true" />
        {t("action")}
      </Button>
      {/* The dialog's text starts at the start wherever the button is: the empty state centres. */}
      <div className="contents text-start">
        <Dialog
          open={open}
          onClose={() => setOpen(false)}
          title={t("title")}
          actions={
            <Button type="submit" form={form} variant="primary" loading={saving || going}>
              {t("add")}
            </Button>
          }
        >
          <p>{t("hint")}</p>
          {refusal && !onUrl && named.length === 0 && (
            <p role="alert" className="text-danger-ink">
              {words}
            </p>
          )}
          {/* The fields scroll inside the dialog on a short screen, its buttons in view. */}
          <form
            id={form}
            onSubmit={add}
            className="-mx-1 mt-2 grid max-h-[55dvh] gap-4 overflow-y-auto px-1 pb-1"
            noValidate
          >
            <div className="grid gap-1.5">
              <TextField
                label={t("linkedin_url")}
                hint={t("linkedin_url_hint")}
                value={url}
                required
                error={onUrl ? words : undefined}
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
              {existing ? (
                <p className="text-sm">
                  <Link href={leadPage(existing)}>{t("open_existing")}</Link>
                </p>
              ) : null}
            </div>
            <PersonFields
              values={values}
              onChange={(field, value) => setValues((current) => ({ ...current, [field]: value }))}
              errorOf={(field) => (named.includes(field) ? words : undefined)}
            />
          </form>
        </Dialog>
      </div>
    </>
  );
}

// The person's six profile fields as a dialog's form holds them (README.md "Screens"): the lead
// page's Edit (edit.tsx) and the Leads screen's Add lead (../leads/add-lead.tsx). Each is labelled
// in contacts' words and kept within its source's limit, the first name required, and shows the
// words of a refusal when its form says the refusal names it.
"use client";

import { TextField } from "@whytide/ui";
import { useTranslations } from "next-intl";
import { EDITABLE_FIELDS, type EditableField, PERSON_FIELD_MAX } from "../../domain/constants.ts";

/** The six fields as a form holds them: an empty string for none. */
export type FieldValues = Record<EditableField, string>;
type Problem = { code?: unknown; details?: { fields?: unknown; personId?: unknown } };
/** An error answer: its code, the fields it names, and the person a lead_exists names. */
export type Refusal = { code: string; fields: readonly string[]; personId?: string };

/** The refusal of an error answer, or of a request that got none. */
export function refusalOf(error: unknown): Refusal {
  const { code, details } = (error ?? {}) as Problem;
  const fields = Array.isArray(details?.fields) ? details.fields.map(String) : [];
  const personId = typeof details?.personId === "string" ? details.personId : undefined;
  return { code: typeof code === "string" ? code : "internal_error", fields, personId };
}

type Props = {
  values: FieldValues;
  onChange: (field: EditableField, value: string) => void;
  /** The words of a refusal under the field, when it names the field. */
  errorOf: (field: EditableField) => string | undefined;
};

/** The six fields, in the form's order (EDITABLE_FIELDS). */
export function PersonFields({ values, onChange, errorOf }: Props) {
  const t = useTranslations("contacts.lead_edit");
  const page = useTranslations("contacts.lead");
  const labels: FieldValues = {
    firstName: t("first_name"),
    lastName: t("last_name"),
    headline: page("headline"),
    title: page("job_title"),
    companyName: page("company"),
    locationText: page("location"),
  };
  return EDITABLE_FIELDS.map((field) => (
    <TextField
      key={field}
      label={labels[field]}
      value={values[field]}
      maxLength={PERSON_FIELD_MAX[field]}
      required={field === "firstName"}
      error={errorOf(field)}
      autoComplete="off"
      onChange={(event) => onChange(field, event.target.value)}
    />
  ));
}

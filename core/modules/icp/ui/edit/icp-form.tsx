// The ICP form (README "The screen"): the record's fields in cards, the people's and the companies'
// side by side on a wide screen, and its criteria, saved from the browser through the api, the
// criteria first, so that weights it refuses leave the record as it was; the save bar stays in view
// while the form has changes. A code the api answers is shown in words next to the field it names;
// another one in an ErrorState.
"use client";

import {
  Badge,
  Button,
  Card,
  ChipInput,
  ErrorState,
  PageHeader,
  SaveBar,
  type SelectOption,
  TextArea,
  TextField,
  Toast,
} from "@whytide/ui";
import { browserApi } from "@whytide/web/api/browser";
import { useLocale, useTranslations } from "next-intl";
import { type FormEvent, useMemo, useState } from "react";
import { COUNTRIES, type Criterion, LIMITS, SENIORITIES, SIZE_RANGES } from "../../domain/lists.ts";
import { errorLabels, seniorityLabels, sizeRangeLabels } from "../labels.ts";
import { CriteriaTable } from "./criteria.tsx";

/** What a save sends: every field, since `PUT …/icp` replaces them all. */
type Fields = {
  name: string;
  titles: string[];
  seniorities: string[];
  industries: string[];
  sizeRanges: string[];
  countries: string[];
  mustHaves: string;
  disqualifiers: string;
};
type Place = keyof Fields | "criteria";
type Problem = { code?: unknown; details?: { fields?: unknown } };
type Props = { workspace: string; icp: Fields & { version: number }; criteria: Criterion[] };

/** Where an error can show: next to a field, or under the criteria. */
const PLACES: readonly Place[] = [
  "name",
  "titles",
  "seniorities",
  "industries",
  "sizeRanges",
  "countries",
  "mustHaves",
  "disqualifiers",
  "criteria",
];
/** The field each of icp's codes is about. */
const PLACE_OF_CODE: Record<string, Place> = {
  icp_weights_must_sum_100: "criteria",
  icp_unknown_seniority: "seniorities",
  icp_unknown_size_range: "sizeRanges",
  icp_unknown_country: "countries",
};

export function IcpForm(props: Props) {
  const t = useTranslations("icp.screen");
  const whole = useTranslations();
  const locale = useLocale();
  const [fields, setFields] = useState(() => fieldsOf(props.icp));
  const [criteria, setCriteria] = useState(props.criteria);
  const [version, setVersion] = useState(props.icp.version);
  /** What the api holds, to tell the form's changes by. */
  const [stored, setStored] = useState(() => JSON.stringify([fieldsOf(props.icp), props.criteria]));
  const [errors, setErrors] = useState<Partial<Record<Place, string>>>({});
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const seniorities = optionsOf(SENIORITIES, seniorityLabels(whole));
  const sizes = optionsOf(SIZE_RANGES, sizeRangeLabels(whole));
  const words = errorLabels(whole);

  const edit = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  /** An error answer: in words next to the fields it names, else as the code in an ErrorState. */
  const refuse = (error: unknown) => {
    const { code, details } = (error ?? {}) as Problem;
    const own = typeof code === "string" && Object.hasOwn(PLACE_OF_CODE, code);
    const named = own ? PLACE_OF_CODE[code as string] : undefined;
    const paths = Array.isArray(details?.fields) ? details.fields.map(String) : [];
    const places = named ? [named] : code === "validation_failed" ? paths.map(placeOf) : [];
    const known = places.filter((place): place is Place => place !== undefined);
    if (known.length === 0) return setFailure(typeof code === "string" ? code : "internal_error");
    const text = named ? words[code as keyof typeof words] : t("invalid");
    setErrors(Object.fromEntries(known.map((place) => [place, text])));
  };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    setFailure(undefined);
    setSaved(false);
    try {
      const api = browserApi();
      const params = { path: { workspaceId: props.workspace } };
      const weights = await api.PUT("/v1/workspaces/{workspaceId}/icp/criteria", {
        params,
        body: { criteria },
      });
      if (!weights.data) return refuse(weights.error);
      setCriteria(weights.data.criteria);
      const record = await api.PUT("/v1/workspaces/{workspaceId}/icp", { params, body: fields });
      if (!record.data) return refuse(record.error);
      setFields(fieldsOf(record.data));
      setVersion(record.data.version);
      setStored(JSON.stringify([fieldsOf(record.data), weights.data.criteria]));
      setSaved(true);
    } catch {
      setFailure("internal_error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Badge tone="accent">{t("version", { version })}</Badge>}
      />
      <form className="grid gap-6" onSubmit={save}>
        <Card title={t("section.profile")}>
          <div className="max-w-md">
            <TextField
              label={t("name")}
              value={fields.name}
              maxLength={LIMITS.name}
              error={errors.name}
              onChange={(event) => edit("name", event.target.value)}
            />
          </div>
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title={t("section.people")} description={t("section.people_hint")}>
            <ChipInput
              label={t("titles")}
              value={fields.titles}
              error={errors.titles}
              onChange={(value) => edit("titles", value)}
            />
            <ChipInput
              label={t("seniorities")}
              options={seniorities}
              value={fields.seniorities}
              error={errors.seniorities}
              onChange={(value) => edit("seniorities", value)}
            />
          </Card>
          <Card title={t("section.companies")} description={t("section.companies_hint")}>
            <ChipInput
              label={t("industries")}
              value={fields.industries}
              error={errors.industries}
              onChange={(value) => edit("industries", value)}
            />
            <ChipInput
              label={t("size_ranges")}
              options={sizes}
              value={fields.sizeRanges}
              error={errors.sizeRanges}
              onChange={(value) => edit("sizeRanges", value)}
            />
            <ChipInput
              label={t("countries")}
              options={countries}
              value={fields.countries}
              error={errors.countries}
              onChange={(value) => edit("countries", value)}
            />
          </Card>
        </div>
        <Card title={t("section.rules")}>
          <div className="grid gap-5 lg:grid-cols-2">
            <TextArea
              label={t("must_haves")}
              hint={t("data_hint")}
              maxLength={LIMITS.text}
              value={fields.mustHaves}
              error={errors.mustHaves}
              onChange={(event) => edit("mustHaves", event.target.value)}
            />
            <TextArea
              label={t("disqualifiers")}
              hint={t("data_hint")}
              maxLength={LIMITS.text}
              value={fields.disqualifiers}
              error={errors.disqualifiers}
              onChange={(event) => edit("disqualifiers", event.target.value)}
            />
          </div>
        </Card>
        <CriteriaTable
          criteria={criteria}
          error={errors.criteria}
          onChange={(rows) => {
            setCriteria(rows);
            setSaved(false);
          }}
        />
        {failure ? <ErrorState module="icp" code={failure} /> : null}
        <SaveBar
          dirty={JSON.stringify([fields, criteria]) !== stored}
          note={<span className="text-pretty">{t("rescore_note")}</span>}
        >
          <Button type="submit" variant="primary" loading={saving}>
            {whole("ui.action.save")}
          </Button>
        </SaveBar>
        <Toast message={saved ? t("saved") : undefined} />
      </form>
    </>
  );
}

/** The fields of an answer, without its id, version and time, which a save must not send. */
function fieldsOf(icp: Fields): Fields {
  const { name, titles, seniorities, industries, sizeRanges, countries } = icp;
  const { mustHaves, disqualifiers } = icp;
  return { name, titles, seniorities, industries, sizeRanges, countries, mustHaves, disqualifiers };
}

/** The field a path of `details.fields` names: `titles.3` is titles, `criteria.0.weight` criteria. */
function placeOf(path: string): Place | undefined {
  const first = path.split(".")[0];
  return PLACES.find((place) => place === first);
}

function optionsOf<T extends string>(values: readonly T[], labels: Record<T, string>) {
  return values.map((value): SelectOption => ({ value, label: labels[value] }));
}

/** Every ISO code by its name in the user's locale, in that locale's alphabetical order. */
function countryOptions(locale: string): SelectOption[] {
  const names = new Intl.DisplayNames([locale], { type: "region" });
  const collator = new Intl.Collator(locale);
  return COUNTRIES.map((code) => ({ value: code, label: names.of(code) ?? code })).sort((a, b) =>
    collator.compare(a.label, b.label),
  );
}

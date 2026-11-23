// The ICP form (README "The screen"): the audience picker and the draft card on top, then the chosen
// audience's fields in cards, the people's and the companies' side by side on a wide screen, and its
// criteria, saved from the browser through the api's routes of that audience only, the criteria
// first, so that weights it refuses leave the record as it was; the save bar stays in view while the
// form has changes. A code the api answers is shown in words next to the field it names; another one
// in an ErrorState. A draft used replaces the form's fields, saved. An audience the visitor may not
// write, another member's or the default for a Member, shows its fields disabled under a hint,
// without the draft card and the save bar (README "Decided here").
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
import type { AudienceResponse, AudiencesResponse, DraftResponse } from "../../schemas/icp.ts";
import { errorLabels, seniorityLabels, sizeRangeLabels } from "../labels.ts";
import { AudiencePicker } from "./audience-picker.tsx";
import { AUDIENCE_PATH } from "./constants.ts";
import { CriteriaTable } from "./criteria.tsx";
import { DraftCard } from "./draft-card.tsx";

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
type Props = {
  workspace: string;
  /** The workspace's audiences, the default first, for the picker. */
  audiences: AudienceResponse[];
  /** The limits the api answers with the audiences, for the picker. */
  limits: AudiencesResponse["limits"];
  /** The audience the screen shows, and whether it is the default, whose draft needs no id. */
  icp: Fields & { id: string; version: number };
  isDefault: boolean;
  /** Whether the visitor may write it: its owner, or a holder of icp.manage. */
  writable: boolean;
  criteria: Criterion[];
  draft: DraftResponse;
};

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
  const [stored, setStored] = useState(() => ({
    fields: fieldsOf(props.icp),
    criteria: props.criteria,
  }));
  const [errors, setErrors] = useState<Partial<Record<Place, string>>>({});
  const [failure, setFailure] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const countries = useMemo(() => countryOptions(locale), [locale]);
  const seniorities = optionsOf(SENIORITIES, seniorityLabels(whole));
  const sizes = optionsOf(SIZE_RANGES, sizeRangeLabels(whole));
  const words = errorLabels(whole);
  const dirty =
    JSON.stringify([fields, criteria]) !== JSON.stringify([stored.fields, stored.criteria]);

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
      const params = { path: { workspaceId: props.workspace, icpId: props.icp.id } };
      const weights = await api.PUT(`${AUDIENCE_PATH}/criteria`, { params, body: { criteria } });
      if (!weights.data) return refuse(weights.error);
      setCriteria(weights.data.criteria);
      const record = await api.PUT(AUDIENCE_PATH, { params, body: fields });
      if (!record.data) return refuse(record.error);
      setFields(fieldsOf(record.data));
      setVersion(record.data.version);
      setStored({ fields: fieldsOf(record.data), criteria: weights.data.criteria });
      setSaved(true);
    } catch {
      setFailure("internal_error");
    } finally {
      setSaving(false);
    }
  };
  /** A draft used: the saved ICP replaces the form's fields, and its unsaved criteria the stored. */
  const accepted = (icp: Fields & { version: number }) => {
    setFields(fieldsOf(icp));
    setCriteria(stored.criteria);
    setVersion(icp.version);
    setStored({ fields: fieldsOf(icp), criteria: stored.criteria });
    setErrors({});
    setFailure(undefined);
    setSaved(true);
  };

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={<Badge tone="accent">{t("version", { version })}</Badge>}
      />
      <AudiencePicker
        workspace={props.workspace}
        audiences={props.audiences}
        limits={props.limits}
        chosen={props.icp.id}
      />
      {props.writable ? (
        <DraftCard
          workspace={props.workspace}
          icpId={props.isDefault ? undefined : props.icp.id}
          draft={props.draft}
          replaces={hasTargeting(stored.fields) || dirty}
          onAccepted={accepted}
        />
      ) : (
        <p className="text-pretty text-ink-muted">
          {t("not_owner", { audience: props.isDefault ? "default" : "other" })}
        </p>
      )}
      <form className="grid gap-6" onSubmit={save}>
        <Card title={t("section.profile")}>
          <div className="max-w-md">
            <TextField
              label={t("name")}
              value={fields.name}
              maxLength={LIMITS.name}
              error={errors.name}
              disabled={!props.writable}
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
              disabled={!props.writable}
              onChange={(value) => edit("titles", value)}
            />
            <ChipInput
              label={t("seniorities")}
              options={seniorities}
              value={fields.seniorities}
              error={errors.seniorities}
              disabled={!props.writable}
              onChange={(value) => edit("seniorities", value)}
            />
          </Card>
          <Card title={t("section.companies")} description={t("section.companies_hint")}>
            <ChipInput
              label={t("industries")}
              value={fields.industries}
              error={errors.industries}
              disabled={!props.writable}
              onChange={(value) => edit("industries", value)}
            />
            <ChipInput
              label={t("size_ranges")}
              options={sizes}
              value={fields.sizeRanges}
              error={errors.sizeRanges}
              disabled={!props.writable}
              onChange={(value) => edit("sizeRanges", value)}
            />
            <ChipInput
              label={t("countries")}
              options={countries}
              value={fields.countries}
              error={errors.countries}
              disabled={!props.writable}
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
              disabled={!props.writable}
              onChange={(event) => edit("mustHaves", event.target.value)}
            />
            <TextArea
              label={t("disqualifiers")}
              hint={t("data_hint")}
              maxLength={LIMITS.text}
              value={fields.disqualifiers}
              error={errors.disqualifiers}
              disabled={!props.writable}
              onChange={(event) => edit("disqualifiers", event.target.value)}
            />
          </div>
        </Card>
        <CriteriaTable
          criteria={criteria}
          error={errors.criteria}
          disabled={!props.writable}
          onChange={(rows) => {
            setCriteria(rows);
            setSaved(false);
          }}
        />
        {failure ? <ErrorState module="icp" code={failure} /> : null}
        {props.writable ? (
          <SaveBar dirty={dirty} note={<span className="text-pretty">{t("rescore_note")}</span>}>
            <Button type="submit" variant="primary" loading={saving}>
              {whole("ui.action.save")}
            </Button>
          </SaveBar>
        ) : null}
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

/**
 * Whether a targeting field holds a value, as domain/rules.ts's hasTargeting tells it of the stored
 * ICP, whose answers are trimmed: any field but the name. The screen cannot import the rules.
 */
function hasTargeting(icp: Fields): boolean {
  const { titles, seniorities, industries, sizeRanges, countries } = icp;
  const lists = [titles, seniorities, industries, sizeRanges, countries];
  return lists.some((list) => list.length > 0) || icp.mustHaves !== "" || icp.disqualifiers !== "";
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

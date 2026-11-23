"use client";
// The fields of a Web research source (README.md "Screen"; gamma-wr-030), as the add form and the
// card's Edit show them: what to look for, the part of the country, the languages (the kind's list,
// each named in the member's locale by Intl.DisplayNames) and the start pages, one a line. A
// refusal of a field shows under it.
import { ChipInput, TextArea, TextField } from "@whytide/ui";
import { useLocale, useTranslations } from "next-intl";
import { useMemo } from "react";
import {
  FOCUS,
  LANGUAGES,
  LANGUAGES_MAX,
  REGION_MAX_CHARS,
  START_PAGES_MAX,
} from "../../sources/web_research/constants.ts";
import { START_PAGES_BOX_CHARS } from "./constants.ts";

/** What the member typed: the start pages as the box holds them, a line each. */
export type Research = {
  focus: string;
  region: string;
  languages: string[];
  startPages: string;
};

export const EMPTY_RESEARCH: Research = { focus: "", region: "", languages: [], startPages: "" };

/** The config the api takes: a field left empty is left out. */
export function configOf(typed: Research): Record<string, unknown> {
  const startPages = typed.startPages
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return {
    focus: typed.focus,
    ...(typed.region.trim() === "" ? {} : { region: typed.region }),
    ...(typed.languages.length === 0 ? {} : { languages: typed.languages }),
    ...(startPages.length === 0 ? {} : { startPages }),
  };
}

/** What a source's config holds, for the fields to start on. */
export function researchOf(config: { [key: string]: unknown }): Research {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    focus: typeof config.focus === "string" ? config.focus : "",
    region: typeof config.region === "string" ? config.region : "",
    languages: strings(config.languages),
    startPages: strings(config.startPages).join("\n"),
  };
}

/** A language's name in the member's locale; its code when the browser does not know it. */
export function useLanguageName(): (code: string) => string {
  const locale = useLocale();
  const names = useMemo(() => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      return undefined;
    }
  }, [locale]);
  return (code) => {
    try {
      return names?.of(code) ?? code;
    } catch {
      return code;
    }
  };
}

export function ResearchFields(props: {
  value: Research;
  onChange: (next: Research) => void;
  /** The refusal under the field at this path, when it names it. */
  errorOf: (path: string) => string | undefined;
}) {
  const { value, onChange, errorOf } = props;
  const t = useTranslations("signals.sources");
  const locale = useLocale();
  const nameOf = useLanguageName();
  const options = useMemo(
    () =>
      LANGUAGES.map((code) => ({ value: code, label: nameOf(code) })).sort((a, b) =>
        a.label.localeCompare(b.label, locale),
      ),
    // biome-ignore lint/correctness/useExhaustiveDependencies: nameOf follows the locale
    [locale],
  );
  return (
    <>
      <TextField
        label={t("focus")}
        hint={t("focus_hint")}
        error={errorOf("config.focus")}
        required
        minLength={FOCUS.min}
        maxLength={FOCUS.max}
        value={value.focus}
        onChange={(event) => onChange({ ...value, focus: event.target.value })}
      />
      <TextField
        label={t("region")}
        hint={t("region_hint")}
        error={errorOf("config.region")}
        maxLength={REGION_MAX_CHARS}
        value={value.region}
        onChange={(event) => onChange({ ...value, region: event.target.value })}
      />
      <ChipInput
        label={t("languages")}
        hint={t("languages_hint", { max: LANGUAGES_MAX })}
        error={errorOf("config.languages")}
        options={options}
        value={value.languages}
        onChange={(languages) => onChange({ ...value, languages })}
      />
      <TextArea
        label={t("start_pages")}
        hint={t("start_pages_hint", { max: START_PAGES_MAX })}
        error={errorOf("config.startPages")}
        rows={3}
        maxLength={START_PAGES_BOX_CHARS}
        value={value.startPages}
        onChange={(event) => onChange({ ...value, startPages: event.target.value })}
      />
    </>
  );
}

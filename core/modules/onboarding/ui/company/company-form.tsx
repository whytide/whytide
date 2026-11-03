// The Company Knowledge form (README "The screen"), a client component: the website card, with the
// empty state of a record with nothing in it and the Draft from the website (website-fetch.tsx); the
// fields in four cards, two side by side on a wide screen: the texts with their limits and counters,
// the lists as chips, a source badge per field that explains itself on hover and on keyboard focus;
// and the save bar, which stays in view while the form has changes, with the line that says when the
// fields last changed and by what, and Save, which PUTs every field and shows what the api answered:
// the saved record, the fields at fault, or the failure with a retry. A pending draft's review is
// draft-review.tsx.
"use client";

import {
  Badge,
  Button,
  Card,
  ChipInput,
  ErrorState,
  Link,
  SaveBar,
  TextArea,
  TextField,
  Toast,
  Tooltip,
} from "@whytide/ui";
import { ExternalLink, History, PenLine, Sparkles } from "@whytide/ui/icons";
import { browserApi } from "@whytide/web/api/browser";
import { useFormatter, useTranslations } from "next-intl";
import { type FormEvent, type ReactNode, useState } from "react";
import { documentName } from "../../domain/documents.ts";
import { CONTENT_FIELDS, type ContentField, LIMITS } from "../../domain/fields.ts";
import type {
  CompanyKnowledgeBody,
  CompanyKnowledgeResponse,
} from "../../schemas/company-knowledge.ts";
import { DraftReview } from "./draft-review.tsx";
import { WebsiteFetch } from "./website-fetch.tsx";

type Knowledge = CompanyKnowledgeResponse;
type Body = CompanyKnowledgeBody;
type Source = Knowledge["fieldSources"][ContentField];
type Problems = { [F in keyof Body]?: string };

const PATH = "/v1/workspaces/{workspaceId}/onboarding/company-knowledge";
const WHEN = { dateStyle: "medium", timeStyle: "short" } as const;

/** No website and no content: nothing saved yet. */
function isEmpty(record: Knowledge): boolean {
  const blank = (field: ContentField) => record[field].length === 0;
  return !record.sourceUrl && CONTENT_FIELDS.every(blank);
}

/** The field source written last: when the fields last changed, and by what (README "The screen"). */
function lastChange(sources: Knowledge["fieldSources"]): Source {
  let last: Source;
  for (const source of Object.values(sources)) {
    if (source && (!last || Date.parse(source.at) > Date.parse(last.at))) last = source;
  }
  return last;
}

/** Whether two forms send the same, the website's none and empty alike. */
function same(a: Body, b: Body): boolean {
  const plain = (body: Body) => JSON.stringify({ ...body, sourceUrl: body.sourceUrl ?? "" });
  return plain(a) === plain(b);
}

/** What the PUT sends: the website and every content field of the record. */
function bodyOf(record: Knowledge): Body {
  return {
    sourceUrl: record.sourceUrl,
    oneLiner: record.oneLiner,
    longDescription: record.longDescription,
    products: record.products,
    painPoints: record.painPoints,
    featuresBenefits: record.featuresBenefits,
    proofPoints: record.proofPoints,
    competitors: record.competitors,
    tone: record.tone,
  };
}

export function CompanyForm({ workspace, initial }: { workspace: string; initial: Knowledge }) {
  const t = useTranslations("onboarding");
  const shared = useTranslations("ui");
  const format = useFormatter();
  const [record, setRecord] = useState(initial);
  const [form, setForm] = useState(() => bodyOf(initial));
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (change: Partial<Body>) => setForm((current) => ({ ...current, ...change }));
  const sources = record.fieldSources;
  const last = lastChange(sources);

  /** PUTs the form: the saved record, or undefined once the fields at fault or the failure show. */
  async function put(): Promise<Knowledge | undefined> {
    setFailure(undefined);
    const params = { path: { workspaceId: workspace } };
    const { data, error } = await browserApi().PUT(PATH, { params, body: form });
    if (data) {
      setRecord(data);
      setForm(bodyOf(data));
      setProblems({});
      return data;
    }
    // A refusal names the fields at fault by their paths: the first segment is the form's field.
    const { code, details } = (error ?? {}) as { code?: unknown; details?: { fields?: string[] } };
    const url = code === "company_knowledge_invalid_url";
    const text = url ? t("errors.company_knowledge_invalid_url") : t("company.invalid");
    const fields = details?.fields ?? [];
    setProblems(Object.fromEntries(fields.map((path) => [path.split(".")[0], text])));
    if (fields.length === 0) setFailure(typeof code === "string" ? code : "internal_error");
    return undefined;
  }

  /** Save, and its retry, which sends the form as it is then (a PUT replaces every field). */
  async function submit() {
    setSaving(true);
    setMessage(undefined);
    try {
      if (await put()) setMessage(t("company.saved"));
    } catch {
      setFailure("internal_error");
    } finally {
      setSaving(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  const website = (form.sourceUrl ?? "").trim();
  /** Before a Draft, the form is saved when its website changed: the fetch reads what is typed. */
  const prepare = async () => (website === (record.sourceUrl ?? "") ? record : put());

  /** A proof point keeps its page while its text stays; a typed one has none (README "The screen"). */
  const proofPoints = (texts: string[]) =>
    texts.map((text) => form.proofPoints.find((point) => point.text === text) ?? { text });

  return (
    <form onSubmit={save} noValidate className="grid gap-6">
      <div className="grid gap-4 rounded-xl border border-line bg-surface p-5 shadow-xs">
        {isEmpty(record) ? (
          <p className="flex items-start gap-2.5 rounded-lg bg-accent-soft px-3.5 py-3 text-accent-ink">
            <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t("company.empty")}
          </p>
        ) : null}
        <WebsiteFetch
          workspace={workspace}
          record={record}
          website={website !== ""}
          prepare={prepare}
          onRecord={setRecord}
          field={
            <TextField
              type="url"
              label={t("company.source_url")}
              value={form.sourceUrl ?? ""}
              maxLength={LIMITS.url}
              error={problems.sourceUrl}
              onChange={(event) => set({ sourceUrl: event.target.value })}
            />
          }
        />
      </div>
      {record.pendingDraft ? (
        <DraftReview
          workspace={workspace}
          record={record}
          draft={record.pendingDraft}
          onAccepted={(accepted) => {
            setRecord(accepted);
            setForm(bodyOf(accepted));
          }}
          onDiscarded={setRecord}
        />
      ) : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={t("company.section.about")} description={t("company.section.about_hint")}>
          <Sourced field="oneLiner" source={sources.oneLiner}>
            <TextField
              label={t("company.one_liner")}
              value={form.oneLiner}
              maxLength={LIMITS.oneLiner}
              error={problems.oneLiner}
              onChange={(event) => set({ oneLiner: event.target.value })}
            />
          </Sourced>
          <Sourced field="longDescription" source={sources.longDescription}>
            <TextArea
              label={t("company.long_description")}
              value={form.longDescription}
              maxLength={LIMITS.longDescription}
              rows={8}
              error={problems.longDescription}
              onChange={(event) => set({ longDescription: event.target.value })}
            />
          </Sourced>
        </Card>
        <Card title={t("company.section.offer")} description={t("company.section.offer_hint")}>
          <Sourced field="products" source={sources.products}>
            <ChipInput
              label={t("company.products")}
              value={form.products}
              error={problems.products}
              onChange={(products) => set({ products })}
            />
          </Sourced>
          <Sourced field="featuresBenefits" source={sources.featuresBenefits}>
            <ChipInput
              label={t("company.features_benefits")}
              value={form.featuresBenefits}
              error={problems.featuresBenefits}
              onChange={(featuresBenefits) => set({ featuresBenefits })}
            />
          </Sourced>
          <Sourced field="proofPoints" source={sources.proofPoints}>
            <ChipInput
              label={t("company.proof_points")}
              value={form.proofPoints.map((point) => point.text)}
              error={problems.proofPoints}
              onChange={(texts) => set({ proofPoints: proofPoints(texts) })}
            />
          </Sourced>
        </Card>
        <Card title={t("company.section.market")} description={t("company.section.market_hint")}>
          <Sourced field="painPoints" source={sources.painPoints}>
            <ChipInput
              label={t("company.pain_points")}
              value={form.painPoints}
              error={problems.painPoints}
              onChange={(painPoints) => set({ painPoints })}
            />
          </Sourced>
          <Sourced field="competitors" source={sources.competitors}>
            <ChipInput
              label={t("company.competitors")}
              value={form.competitors}
              error={problems.competitors}
              onChange={(competitors) => set({ competitors })}
            />
          </Sourced>
        </Card>
        <Card title={t("company.section.voice")} description={t("company.section.voice_hint")}>
          <Sourced field="tone" source={sources.tone}>
            <TextArea
              label={t("company.tone")}
              value={form.tone}
              maxLength={LIMITS.tone}
              rows={3}
              error={problems.tone}
              onChange={(event) => set({ tone: event.target.value })}
            />
          </Sourced>
        </Card>
      </div>
      {failure ? <ErrorState module="onboarding" code={failure} onRetry={submit} /> : null}
      <SaveBar
        dirty={!same(form, bodyOf(record))}
        note={
          last ? (
            <span data-part="last-changed" className="inline-flex items-start gap-1.5">
              <History aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <span>
                {t.rich("company.last_changed", {
                  kind: last.kind,
                  when: format.dateTime(new Date(last.at), WHEN),
                  time: (chunks) => <time dateTime={last.at}>{chunks}</time>,
                })}
              </span>
            </span>
          ) : undefined
        }
      >
        <Button type="submit" variant="primary" loading={saving}>
          {shared("action.save")}
        </Button>
      </SaveBar>
      <Toast message={message} />
    </form>
  );
}

/**
 * A field and its source badge: an AI draft, with the page it came from, or edited by a person. The
 * badge is a Tooltip's trigger: it takes the keyboard's focus, so that its hint shows on focus as on
 * hover, and the hint describes it for a screen reader either way.
 */
function Sourced(props: { field: ContentField; source: Source; children: ReactNode }) {
  const { field, source, children } = props;
  const t = useTranslations("onboarding.company.source");
  // The page comes from the drafter's fetch (alpha-p4-030); only a web address becomes a link. A
  // document's source shows as its name (README "The documents").
  const page =
    source?.sourceUrl && /^https?:\/\//i.test(source.sourceUrl) ? source.sourceUrl : null;
  const fromDocument = source?.sourceUrl ? documentName(source.sourceUrl) : null;
  return (
    <div data-field={field} className="grid content-start gap-2">
      {children}
      {source ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <Tooltip content={t("hint", { kind: source.kind })}>
            {source.kind === "human" ? (
              <Badge>
                <PenLine aria-hidden="true" />
                {t("human")}
              </Badge>
            ) : (
              <Badge tone="accent">
                <Sparkles aria-hidden="true" />
                {t("ai_draft")}
              </Badge>
            )}
          </Tooltip>
          {source.kind === "ai_draft" && fromDocument !== null ? (
            <span data-source="document" className="text-ink-muted">
              {t("document", { name: fromDocument })}
            </span>
          ) : null}
          {source.kind === "ai_draft" && page ? (
            <Link href={page} target="_blank" rel="noopener noreferrer">
              {t("page")}
              <ExternalLink
                aria-hidden="true"
                className="ms-1 inline size-3 align-[-0.125em] rtl:-scale-x-100"
              />
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// The component gallery, for development only: every component of @whytide/ui in every state. The web
// host mounts it at /dev/ui (alpha-p2-040), the tests load it as a bundle (tests/gallery-page.ts). Its
// words are message keys; the section names are the components' names, from the code.
"use client";

import { Copy, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  ChipInput,
  type Column,
  CopyButton,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  Kbd,
  Link,
  LoadingState,
  Logo,
  Menu,
  MenuItem,
  Meter,
  NumberField,
  PageHeader,
  PriceTag,
  ReorderableList,
  SaveBar,
  Select,
  Skeleton,
  StatCard,
  Switch,
  type TableSort,
  TextArea,
  TextField,
  ThemeToggle,
  type Tier,
  Toast,
  Tooltip,
} from "../index.ts";
import { useTranslations } from "../translations.tsx";

// DataTable's rows: twelve leads out of order, three pages of five.
type Lead = { id: string; number: number; tier: Tier };
const TIERS = ["cool", "warm", "hot"] as const;
const LEADS: Lead[] = [7, 2, 11, 4, 9, 1, 12, 5, 3, 10, 6, 8].map((number) => ({
  id: `lead-${number}`,
  number,
  tier: TIERS[number % 3] ?? "cool",
}));

// The entries whose states stack; the others sit side by side.
const STACKED = new Set([
  "PageHeader",
  "EmptyState",
  "ErrorState",
  "DataTable",
  "Meter",
  "Skeleton",
  "SaveBar",
  "ReorderableList",
]);

// Meter's samples: a share in each tone, then none; then three parts of a whole.
const METERS = [
  { value: 92, tone: "hot" },
  { value: 64, tone: "warm" },
  { value: 31, tone: "cool" },
  { value: 72, tone: "accent" },
  { value: 88, tone: "danger" },
  { value: 0, tone: "muted" },
] as const;
const PARTS = [
  { value: 45, tone: "accent" },
  { value: 15, tone: "warm" },
] as const;

// ReorderableList's steps, each named by its own number wherever it moves.
const STEPS = [
  { key: "step-1", number: 1, days: 0 },
  { key: "step-2", number: 2, days: 3 },
  { key: "step-3", number: 3, days: 5 },
];
// NumberField's bounds, in business days.
const DELAY = { min: 0, max: 30 };
// PriceTag's coming change: an instant at noon UTC, the same day in all but the farthest zones.
const PRICE_RISE = "2026-12-01T12:00:00Z";

// Countries for ChipInput's closed list, named in the browser's language as a module names them.
const regions = new Intl.DisplayNames(undefined, { type: "region" });
const countries = ["AT", "CH", "DE", "ES", "FR", "GB", "IT", "NL", "US"].map((code) => ({
  value: code,
  label: regions.of(code) ?? code,
}));
// Languages, named the same way, for a list longer than the list's height: it scrolls.
const languageNames = new Intl.DisplayNames(undefined, { type: "language" });
const languages = "ar da de el en es fi fr hi id it ja ko nl pl pt ru sv tr zh"
  .split(" ")
  .map((code) => ({ value: code, label: languageNames.of(code) ?? code }));

export function Gallery() {
  const t = useTranslations("ui");
  const title = t("gallery.title");
  const [confirming, setConfirming] = useState(false);
  const columns: Column<Lead>[] = [
    {
      id: "name",
      header: t("gallery.column_name"),
      cell: (lead) => t("gallery.lead_name", { number: lead.number }),
      sortValue: (lead) => lead.number,
    },
    {
      id: "tier",
      header: t("gallery.column_tier"),
      cell: (lead) => <Badge tier={lead.tier} />,
      sortValue: (lead) => TIERS.indexOf(lead.tier),
    },
  ];
  const [hint, error] = [t("gallery.hint"), t("gallery.error")];
  const roles = [
    { value: "owner", label: t("role.owner") },
    { value: "admin", label: t("role.admin") },
    { value: "member", label: t("role.member") },
  ];
  const entries: Record<string, ReactNode> = {
    PageHeader: (
      <>
        <PageHeader title={title} />
        <PageHeader
          title={title}
          description={t("gallery.sample_notes")}
          actions={<Button variant="primary">{t("action.save")}</Button>}
        />
        <PageHeader
          title={t("gallery.sample_company")}
          description={t("gallery.sample_title")}
          leading={<Avatar name={t("gallery.sample_company")} size="lg" />}
          meta={
            <>
              <Badge tier="hot" />
              <Badge tone="success">{t("gallery.tone_success")}</Badge>
            </>
          }
        />
      </>
    ),
    Button: (
      <>
        <Button variant="primary">{t("action.save")}</Button>
        <Button>{t("action.cancel")}</Button>
        <Button variant="danger">{t("action.delete")}</Button>
        <Button variant="ghost" size="sm">
          <Copy aria-hidden="true" />
          {t("action.copy")}
        </Button>
        <Button variant="primary" loading>
          {t("action.save")}
        </Button>
        <Button aria-pressed>{t("gallery.pressed")}</Button>
        <ButtonLink href="#gallery-Button" variant="ghost" size="sm">
          {t("action.cancel")}
        </ButtonLink>
      </>
    ),
    Link: <Link href="#gallery-Link">{t("action.cancel")}</Link>,
    Badge: (
      <>
        <Badge tier="hot" />
        <Badge tier="warm" />
        <Badge tier="cool" />
        <Badge>{t("role.owner")}</Badge>
        <Badge>{t("role.admin")}</Badge>
        <Badge>{t("role.member")}</Badge>
        <Badge tone="accent">{t("gallery.tone_accent")}</Badge>
        <Badge tone="success">{t("gallery.tone_success")}</Badge>
        <Badge tone="warning">{t("gallery.tone_warning")}</Badge>
        <Badge tone="danger">{t("gallery.tone_danger")}</Badge>
      </>
    ),
    // Hidden until its badge is hovered or focused.
    Tooltip: (
      <Tooltip content={t("gallery.hint")}>
        <Badge tone="accent">{t("gallery.tone_accent")}</Badge>
      </Tooltip>
    ),
    EmptyState: (
      <>
        <EmptyState />
        <EmptyState action={<Button variant="primary">{t("action.retry")}</Button>} />
      </>
    ),
    // The second code has no message anywhere: it shows the platform's generic text.
    ErrorState: (
      <>
        <ErrorState module="credits" code="insufficient_credits" onRetry={() => {}} />
        <ErrorState module="credits" code="unknown" />
      </>
    ),
    LoadingState: <LoadingState />,
    // The toast is fixed to the viewport: here, to its entry, which contains its layout.
    Toast: (
      <div className="relative h-14 w-full [contain:layout]">
        <Toast message={t("state.copied")} />
      </div>
    ),
    CopyButton: <CopyButton value={title} />,
    // A table sorted by tier, in three pages, then one without rows, then one in the controlled mode.
    DataTable: (
      <>
        <DataTable
          caption={t("gallery.leads")}
          columns={columns}
          rows={LEADS}
          rowHref={(lead) => `#${lead.id}`}
          defaultSort={{ column: "tier", direction: "descending" }}
          pageSize={5}
        />
        <DataTable caption={t("gallery.leads")} columns={columns} rows={[]} />
        <ServerTable />
      </>
    ),
    // Closed, then open from its button: a modal cannot stay open in the page. The second case is
    // rendered only while open, its footer ending in controls Tab passes over.
    Dialog: (
      <>
        <Button variant="danger" onClick={() => setConfirming(true)}>
          {t("action.delete")}
        </Button>
        <Dialog
          open={confirming}
          onClose={() => setConfirming(false)}
          title={t("gallery.delete_title")}
          actions={
            <Button variant="danger" onClick={() => setConfirming(false)}>
              {t("action.delete")}
            </Button>
          }
        >
          <p>{t("gallery.delete_body")}</p>
        </Dialog>
        <StepDialog />
      </>
    ),
    ReorderableList: <Steps />,
    // Each form field: with its hint, with an error, then disabled with a value.
    TextField: (
      <>
        <TextField label={t("gallery.company")} hint={hint} />
        <TextField label={t("gallery.company")} error={error} />
        <TextField
          label={t("gallery.company")}
          defaultValue={t("gallery.sample_company")}
          disabled
        />
      </>
    ),
    TextArea: (
      <>
        <TextArea label={t("gallery.notes")} hint={hint} maxLength={1000} />
        <TextArea label={t("gallery.notes")} error={error} />
        <TextArea
          label={t("gallery.notes")}
          defaultValue={t("gallery.sample_notes")}
          maxLength={1000}
          disabled
        />
      </>
    ),
    Select: (
      <>
        <Select label={t("gallery.role")} hint={hint} options={roles} />
        <Select label={t("gallery.role")} error={error} options={roles} />
        <Select label={t("gallery.role")} options={roles} disabled />
      </>
    ),
    NumberField: <NumberFields />,
    ChipInput: (
      <>
        <ChipInput
          label={t("gallery.job_titles")}
          hint={hint}
          name="titles"
          defaultValue={[t("gallery.sample_title")]}
        />
        <ChipInput
          label={t("gallery.countries")}
          error={error}
          name="countries"
          options={countries}
        />
        <ChipInput
          label={t("gallery.job_titles")}
          defaultValue={[t("gallery.sample_title")]}
          disabled
        />
        <ChipInput label={t("gallery.languages")} options={languages} />
      </>
    ),
    Checkbox: (
      <>
        <Checkbox label={t("gallery.notify")} hint={hint} />
        <Checkbox label={t("gallery.notify")} error={error} />
        <Checkbox label={t("gallery.notify")} defaultChecked disabled />
      </>
    ),
    // On, off, then off and disabled; each named by the label around it.
    Switch: (
      <>
        {[true, false].map((on) => (
          <label key={String(on)} className="flex items-center gap-2.5 text-ink">
            <Switch defaultChecked={on} />
            {t("gallery.notify")}
          </label>
        ))}
        <label className="flex items-center gap-2.5 text-ink-muted">
          <Switch disabled />
          {t("gallery.notify")}
        </label>
      </>
    ),
    // Saved, with its note; then with changes, when it stays at the bottom of its entry in view.
    SaveBar: (
      <>
        <SaveBar dirty={false} note={t("gallery.hint")}>
          <Button variant="primary">{t("action.save")}</Button>
        </SaveBar>
        <SaveBar dirty note={t("gallery.hint")}>
          <Button variant="primary">{t("action.save")}</Button>
        </SaveBar>
      </>
    ),
    Card: (
      <Card title={t("gallery.leads")} level={3} description={t("gallery.sample_notes")}>
        <Skeleton lines={2} />
      </Card>
    ),
    StatCard: (
      <>
        <StatCard label={t("gallery.leads")} value={t("gallery.count", { count: 1284 })} />
        <StatCard
          label={t("tier.hot")}
          value={t("gallery.count", { count: 36 })}
          hint={t("gallery.this_week")}
        />
      </>
    ),
    PriceTag: (
      <>
        <PriceTag credits="0.25" unit={t("gallery.unit_lead")} />
        <PriceTag credits="0" unit={t("gallery.unit_lookup")} />
        <PriceTag
          credits="1"
          unit={t("gallery.unit_lookup")}
          next={{ credits: "1.5", effectiveFrom: PRICE_RISE }}
        />
      </>
    ),
    Meter: (
      <>
        {METERS.map(({ value, tone }) => (
          <div
            key={tone}
            className="grid max-w-sm grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-3"
          >
            <Meter value={value} tone={tone} />
            <span className="text-end text-ink-muted tabular-nums">
              {t("gallery.count", { count: value })}
            </span>
          </div>
        ))}
        <div className="max-w-sm">
          <Meter segments={PARTS} size="md" />
        </div>
      </>
    ),
    Skeleton: (
      <>
        <Skeleton />
        <Skeleton shape="table" lines={3} />
      </>
    ),
    Avatar: (
      <>
        <Avatar name={t("gallery.sample_company")} size="lg" />
        <Avatar name={t("gallery.sample_company")} />
        <Avatar name={t("gallery.sample_title")} size="sm" />
        <Avatar name={t("gallery.sample_company")} square />
      </>
    ),
    Kbd: (
      <>
        <Kbd>{t("gallery.key_escape")}</Kbd>
        <Kbd>{t("gallery.key_enter")}</Kbd>
      </>
    ),
    Menu: (
      <Menu
        trigger={
          <>
            <Avatar name={t("gallery.sample_company")} />
            {t("gallery.sample_company")}
          </>
        }
      >
        <MenuItem>
          <Copy aria-hidden="true" />
          {t("action.copy")}
        </MenuItem>
        <MenuItem>
          <Trash2 aria-hidden="true" />
          {t("action.delete")}
        </MenuItem>
      </Menu>
    ),
    ThemeToggle: (
      <div className="w-72">
        <ThemeToggle />
      </div>
    ),
    Logo: <Logo />,
  };
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-line bg-surface/80 px-6 py-3 backdrop-blur-md">
        <Logo />
        <p className="text-ink-muted">{title}</p>
      </header>
      <main className="mx-auto grid max-w-5xl gap-4 p-4 sm:p-6">
        {Object.entries(entries).map(([name, states]) => (
          <section
            key={name}
            aria-labelledby={`gallery-${name}`}
            className="grid gap-4 rounded-2xl border border-line bg-surface p-5 shadow-xs md:grid-cols-[8rem_minmax(0,1fr)]"
          >
            <h2 id={`gallery-${name}`} className="font-mono text-xs font-medium text-ink-muted">
              {name}
            </h2>
            <div className={STACKED.has(name) ? "grid gap-4" : "flex flex-wrap items-start gap-3"}>
              {states}
            </div>
          </section>
        ))}
      </main>
    </div>
  );
}

/** DataTable in the controlled mode, as a module drives it from its server: five leads a page. */
function ServerTable() {
  const t = useTranslations("ui");
  const [sort, setSort] = useState<TableSort>({ column: "name", direction: "descending" });
  const [page, setPage] = useState(0);
  const sign = sort.direction === "descending" ? -1 : 1;
  const ordered = LEADS.toSorted((a, b) => sign * (a.number - b.number));
  const columns: Column<Lead>[] = [
    {
      id: "name",
      header: t("gallery.column_name"),
      cell: (lead) => t("gallery.lead_name", { number: lead.number }),
      sortable: true,
    },
    { id: "tier", header: t("gallery.column_tier"), cell: (lead) => <Badge tier={lead.tier} /> },
  ];
  return (
    <DataTable
      caption={t("gallery.server_leads")}
      columns={columns}
      rows={ordered.slice(page * 5, page * 5 + 5)}
      rowHref={(lead) => `#${lead.id}`}
      sort={sort}
      onSortChange={(next) => {
        setSort(next);
        setPage(0);
      }}
      pager={{
        onPrevious: page > 0 ? () => setPage(page - 1) : undefined,
        onNext: (page + 1) * 5 < LEADS.length ? () => setPage(page + 1) : undefined,
      }}
    />
  );
}

/**
 * Dialog's second case: rendered only while it is in use, so that Save and Cancel unmount it while
 * it is open. Its footer ends in a disabled and a hidden control, which Tab passes over.
 */
function StepDialog() {
  const t = useTranslations("ui");
  const [editing, setEditing] = useState(false);
  const [delay, setDelay] = useState<number | null>(3);
  return (
    <>
      <Button onClick={() => setEditing(true)}>{t("gallery.edit_step")}</Button>
      {editing ? (
        <Dialog
          open
          onClose={() => setEditing(false)}
          title={t("gallery.edit_step")}
          actions={
            <>
              <Button variant="primary" onClick={() => setEditing(false)}>
                {t("action.save")}
              </Button>
              <Button variant="danger" disabled>
                {t("action.delete")}
              </Button>
              <Button hidden>{t("action.retry")}</Button>
            </>
          }
        >
          <NumberField
            label={t("gallery.delay")}
            unit={t("gallery.business_days")}
            value={delay}
            onChange={setDelay}
            {...DELAY}
          />
        </Dialog>
      ) : null}
    </>
  );
}

/** ReorderableList with Remove: three steps the person moves or removes. */
function Steps() {
  const t = useTranslations("ui");
  const [steps, setSteps] = useState(STEPS);
  const items = steps.map((step) => {
    const name = t("gallery.step_name", { number: step.number });
    return {
      key: step.key,
      name,
      content: (
        <div className="grid gap-0.5">
          <span className="font-medium text-ink">{name}</span>
          <span className="text-xs text-ink-muted">
            {t("gallery.step_delay", { days: step.days })}
          </span>
        </div>
      ),
    };
  });
  const move = (from: number, to: number) => {
    const step = steps[from];
    if (step) setSteps(steps.toSpliced(from, 1).toSpliced(to, 0, step));
  };
  return (
    <ReorderableList
      items={items}
      onMove={move}
      onRemove={(index) => setSteps(steps.toSpliced(index, 1))}
    />
  );
}

/**
 * NumberField: a delay with its hint and unit, which shows the module's error while it holds no
 * whole number within its bounds; then one with an error and no unit.
 */
function NumberFields() {
  const t = useTranslations("ui");
  const [delay, setDelay] = useState<number | null>(3);
  return (
    <>
      <NumberField
        label={t("gallery.delay")}
        hint={t("gallery.hint")}
        error={delay === null ? t("gallery.whole_number", DELAY) : undefined}
        unit={t("gallery.business_days")}
        value={delay}
        onChange={setDelay}
        {...DELAY}
      />
      <NumberField
        label={t("gallery.delay")}
        error={t("gallery.error")}
        value={null}
        onChange={() => {}}
        {...DELAY}
      />
    </>
  );
}

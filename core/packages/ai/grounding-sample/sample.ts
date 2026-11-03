// The weekly grounding sample (README.md "The grounding sample"; alpha's done-when: no invented
// fact in twenty why bullets and twenty drafts a week). A module that writes texts from facts
// defines a source as its index loads: qualification its why bullets, messaging its drafts. The
// sample takes up to twenty of each kind made in an ISO week, ranked by a hash seeded with the
// week, so a second draw of the week gives the same; the sheet, a CSV of each text with its facts,
// their sources and an empty column for the reader, goes through the files port to the workspace's
// exports/ (kept 7 days). A person reads it, and the invented facts found are recorded in
// grounding_samples. Nothing here logs: the sheet holds texts (docs/security.md).
import { createHash } from "node:crypto";
import { type PrismaClient, tenantClient, withTenant } from "@whytide/db";
import { AppError, newId, type TenantContext } from "@whytide/platform";
import { filesConfig, filesPort, getAdapter, type PortInstance } from "@whytide/providers";
import { aiErrors } from "../errors.ts";
import { aiIds } from "../ids.ts";

/** The kinds a sample holds, in the sheet's order, up to SAMPLE_SIZE of each. */
export const GROUNDING_KINDS = ["why", "draft"] as const;
export const SAMPLE_SIZE = 20;
export type GroundingKind = (typeof GROUNDING_KINDS)[number];
/** A fact a text may rest on, and where it was read: a record and its field. */
export type GroundingFact = { readonly value: string; readonly source: string };
export type GroundingItem = {
  readonly ref: string;
  readonly text: string;
  readonly facts: readonly GroundingFact[];
};
/** An ISO week, `2026-W43`, from its Monday 00:00 UTC to the next Monday. */
export type GroundingWeek = { readonly week: string; readonly from: Date; readonly to: Date };
/**
 * A module's texts. `list`: the refs of the workspace's texts made in the week; `read`: the texts
 * of the refs drawn, with their facts and sources, a ref gone since left out. Each opens its runs.
 */
export type GroundingSource = {
  readonly kind: GroundingKind;
  readonly list: (tenant: TenantContext, week: GroundingWeek) => Promise<readonly string[]>;
  readonly read: (
    tenant: TenantContext,
    refs: readonly string[],
  ) => Promise<readonly GroundingItem[]>;
};
type Files = PortInstance<typeof filesPort>;

const DAY = 86_400_000;
const sources = new Map<GroundingKind, GroundingSource>();

/** Registers a module's source as its index loads: one per kind. */
export function defineGroundingSource(source: GroundingSource): GroundingSource {
  if (sources.has(source.kind)) {
    throw new AppError(aiErrors.ai_grounding_source_duplicate, { details: { kind: source.kind } });
  }
  sources.set(source.kind, source);
  return source;
}

function sourceOf(kind: GroundingKind): GroundingSource {
  const source = sources.get(kind);
  if (source === undefined) {
    throw new AppError(aiErrors.ai_grounding_source_missing, { details: { kind } });
  }
  return source;
}

/** The week's bounds; ai_grounding_input_invalid for another shape or a week its year lacks. */
export function isoWeek(week: string): GroundingWeek {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  const year = Number(match?.[1]);
  const jan4 = Date.UTC(year, 0, 4);
  // Week 1 holds 4 January; a week belongs to the year of its Thursday.
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY;
  const from = new Date(monday + (Number(match?.[2]) - 1) * 7 * DAY);
  const thursday = new Date(from.getTime() + 3 * DAY);
  if (match === null || match[2] === "00" || thursday.getUTCFullYear() !== year) {
    throw new AppError(aiErrors.ai_grounding_input_invalid, { details: { fields: ["week"] } });
  }
  return { week, from, to: new Date(from.getTime() + 7 * DAY) };
}

/** Up to `count` of the refs, ranked by the hash of the seed and the ref: the same in any order. */
export function drawRefs(refs: readonly string[], count: number, seed: string): string[] {
  const rank = (ref: string) => createHash("sha256").update(`${seed}\n${ref}`).digest("hex");
  return [...new Set(refs)]
    .map((ref) => ({ ref, rank: rank(ref) }))
    .sort((a, b) => (a.rank < b.rank ? -1 : 1))
    .slice(0, count)
    .map(({ ref }) => ref);
}

/** A spreadsheet's formula or control start, which an apostrophe neutralizes (security §2). */
const FORMULA = /^[=+\-@\t\r]/;
function cell(value: string): string {
  const text = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
const line = (cells: readonly string[]) => `${cells.map(cell).join(",")}\r\n`;
const flat = (text: string) => text.replace(/\s+/g, " ").trim();

/** The sheet: a row per text, its facts and their sources a line each, the reader's cell empty. */
export function groundingSheet(
  drawn: ReadonlyMap<GroundingKind, readonly GroundingItem[]>,
): string {
  const rows = GROUNDING_KINDS.flatMap((kind) =>
    (drawn.get(kind) ?? []).map(({ ref, text, facts }) =>
      line([
        kind,
        ref,
        text,
        facts.map((fact) => flat(fact.value)).join("\n"),
        facts.map((fact) => fact.source).join("\n"),
        "",
      ]),
    ),
  );
  return `﻿${line(["kind", "ref", "text", "facts", "sources", "invented_facts"])}${rows.join("")}`;
}

export type GroundingDraw = {
  /** The whole key, `w/<workspaceId>/exports/grounding-sample-<week>.csv`. */
  readonly key: string;
  readonly why: number;
  readonly drafts: number;
  readonly body: string;
};

/**
 * Draws the workspace's sample of the week and writes its sheet to
 * exports/grounding-sample-<week>.csv (a second draw replaces it with the same rows while the
 * week's texts stay as they are).
 */
export async function drawGroundingSample(
  tenant: TenantContext,
  week: string,
  options: { readonly files?: Files } = {},
): Promise<GroundingDraw> {
  const range = isoWeek(week);
  const drawn = new Map<GroundingKind, readonly GroundingItem[]>();
  for (const kind of GROUNDING_KINDS) {
    const source = sourceOf(kind);
    const refs = drawRefs(await source.list(tenant, range), SAMPLE_SIZE, week);
    drawn.set(kind, refs.length === 0 ? [] : await source.read(tenant, refs));
  }
  const body = groundingSheet(drawn);
  const files = options.files ?? (await getAdapter(filesPort, filesConfig.PROVIDER_FILES));
  const key = `exports/grounding-sample-${week}.csv`;
  const contentType = "text/csv; charset=utf-8";
  const stored = await files.put({ workspaceId: tenant.workspaceId, key, body, contentType });
  const count = (kind: GroundingKind) => drawn.get(kind)?.length ?? 0;
  return { key: stored.key, why: count("why"), drafts: count("draft"), body };
}

/**
 * The week's reading recorded: the sample's counts, drawn again, the invented facts the reviewer
 * found and who, a user id. A second record of the week replaces the first.
 */
export async function recordGroundingSample(
  tenant: TenantContext,
  input: { readonly week: string; readonly invented: number; readonly reviewedBy: string },
  options: { readonly client?: PrismaClient } = {},
) {
  const { week, invented, reviewedBy } = input;
  const range = isoWeek(week);
  if (!Number.isSafeInteger(invented) || invented < 0 || reviewedBy.length === 0) {
    const fields = reviewedBy.length === 0 ? ["reviewedBy"] : ["invented"];
    throw new AppError(aiErrors.ai_grounding_input_invalid, { details: { fields } });
  }
  const counts: number[] = [];
  for (const kind of GROUNDING_KINDS) {
    counts.push(drawRefs(await sourceOf(kind).list(tenant, range), SAMPLE_SIZE, week).length);
  }
  const [whyCount = 0, draftCount = 0] = counts;
  const data = {
    whyCount,
    draftCount,
    inventedFacts: invented,
    reviewedBy,
    reviewedAt: new Date(),
  };
  const { workspaceId } = tenant;
  const id = newId(aiIds.grounding_sample);
  return withTenant(
    tenant,
    () =>
      tenantClient.groundingSample.upsert({
        where: { workspaceId_week: { workspaceId, week } },
        create: { id, workspaceId, week, ...data },
        update: data,
      }),
    { client: options.client },
  );
}

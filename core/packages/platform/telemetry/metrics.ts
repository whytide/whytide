// The metric registry (alpha-p10-060; coding §3, §9): every metric a host, a package or a module
// emits is declared once, in its metrics.ts, with defineMetrics, and emitted through the recorders it
// returns, which pass on the declared labels only. A label comes from the allow-list: route
// templates, codes and names, never an id, an email, a URL or a key of the PII registry. Under
// APP_ENV=test each emission is kept too, one entry per label set, shared by every copy of this
// module in the process, and written at exit to .tmp/metrics/ at the repository root, where
// `pnpm observability:check` reads it (README "Metrics").
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Attributes, type MetricOptions, metrics } from "@opentelemetry/api";
import { platformConfig } from "../config/platform.ts";
import { AppError, defineErrors } from "../errors/index.ts";
import { piiKeySuffixes, piiKeys } from "../logging/pii.ts";

export type MetricKind = "counter" | "histogram" | "gauge";
export type MetricDefinition = {
  readonly kind: MetricKind;
  readonly labels: readonly string[];
  /** `s`, `By` or an annotation such as `{request}`; Prometheus appends `_seconds` or `_bytes`. */
  readonly unit?: string;
  readonly description?: string;
};
export type RegisteredMetric = MetricDefinition & {
  readonly name: string;
  readonly source: string;
};
export type MetricLabels<D extends MetricDefinition> = {
  readonly [L in D["labels"][number]]: string | number;
};
export type Metric<D extends MetricDefinition> = D["kind"] extends "counter"
  ? { add(value: number, labels: MetricLabels<D>): void }
  : { record(value: number, labels: MetricLabels<D>): void };
/** Per metric, the distinct label sets a test process emitted. */
export type RecordedMetrics = ReadonlyMap<string, readonly Attributes[]>;

/** The labels a metric may carry: route templates, machine codes and the names of things. */
export const metricLabels: readonly string[] = [
  "activity",
  "adapter",
  "code",
  "event",
  "kind",
  "method",
  "outcome",
  "port",
  "route",
  "status",
  "task",
  "trigger",
  "workflow",
];
export const metricErrors = defineErrors({
  invalid_metric: {},
  metric_label_refused: {},
  duplicate_metric: {},
});

const NAME = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const UNIT = /^(?:s|By|\{[a-z_]+\})$/;
const KINDS: readonly MetricKind[] = ["counter", "histogram", "gauge"];
/** Seconds, for a histogram in `s`: the SDK's default buckets are milliseconds. */
const SECONDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const RECORDED = Symbol.for("whytide.metrics.recorded");
const registry = new Map<string, RegisteredMetric>();
recordedStore(); // a test process that emits nothing still rewrites its stale record at exit

/** A label the allow-list holds and the PII registry does not, and no id: `email`, `person_id` fail. */
export function isAllowedLabel(label: string): boolean {
  const pii = piiKeys.includes(label) || piiKeySuffixes.some((suffix) => label.endsWith(suffix));
  return metricLabels.includes(label) && !pii && !/(?:_id|_ids|Id|Ids|url|Url)$/.test(label);
}

/**
 * Registers the metrics of one metrics.ts; `source` is its `import.meta.url`, so a name declared
 * twice fails at start naming both files. Returns a recorder per name: `add` for a counter, `record`
 * for a histogram or a gauge, each taking every declared label and nothing else.
 */
export function defineMetrics<const D extends Record<string, MetricDefinition>>(
  definitions: D,
  source: string,
): { readonly [N in keyof D]: Metric<D[N]> } {
  const recorders: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    const { kind, labels, unit } = definition;
    const invalid = (field: string) =>
      new AppError(metricErrors.invalid_metric, { details: { metric: name, field, source } });
    if (!NAME.test(name)) throw invalid("name");
    if (!KINDS.includes(kind)) throw invalid("kind");
    if (unit !== undefined && !UNIT.test(unit)) throw invalid("unit");
    if (!Array.isArray(labels) || new Set(labels).size !== labels.length) throw invalid("labels");
    const refused = labels.filter((label) => !isAllowedLabel(label));
    if (refused.length > 0) {
      const details = { metric: name, labels: refused, source };
      throw new AppError(metricErrors.metric_label_refused, { details });
    }
    const existing = registry.get(name);
    if (existing) {
      const details = { metric: name, sources: [existing.source, source] };
      throw new AppError(metricErrors.duplicate_metric, { details });
    }
    registry.set(name, Object.freeze({ ...definition, labels: [...labels], name, source }));
    recorders[name] = recorderOf(name, definition);
  }
  return Object.freeze(recorders) as { readonly [N in keyof D]: Metric<D[N]> };
}

export const registeredMetrics = (): ReadonlyMap<string, RegisteredMetric> => registry;

/** What this process emitted so far, under APP_ENV=test; empty otherwise. */
export function recordedMetrics(): RecordedMetrics {
  const recorded = recordedStore() ?? new Map();
  return new Map([...recorded].map(([name, sets]) => [name, [...sets.values()]]));
}

function recorderOf(name: string, definition: MetricDefinition) {
  // Made on first use, after a host's preload started telemetry, so the meter is the SDK's.
  let instrument: { add?(v: number, a: Attributes): void; record?(v: number, a: Attributes): void };
  const emit = (value: number, labels: Readonly<Record<string, unknown>>) => {
    const attributes: Attributes = {};
    for (const label of definition.labels) {
      const given = labels[label];
      if (typeof given === "string" || typeof given === "number") attributes[label] = given;
    }
    remember(name, attributes);
    instrument ??= instrumentOf(name, definition);
    if (definition.kind === "counter") instrument.add?.(value, attributes);
    else instrument.record?.(value, attributes);
  };
  return definition.kind === "counter" ? { add: emit } : { record: emit };
}

function instrumentOf(name: string, { kind, unit, description }: MetricDefinition) {
  const meter = metrics.getMeter("whytide");
  const options: MetricOptions = { ...(unit && { unit }), ...(description && { description }) };
  if (kind === "counter") return meter.createCounter(name, options);
  if (kind === "gauge") return meter.createGauge(name, options);
  const advice = unit === "s" ? { explicitBucketBoundaries: SECONDS } : undefined;
  return meter.createHistogram(name, { ...options, ...(advice && { advice }) });
}

type Store = Map<string, Map<string, Attributes>>;

/** The process's record under APP_ENV=test, made with its exit writer by the first copy to ask. */
function recordedStore(): Store | undefined {
  if (platformConfig.APP_ENV !== "test") return undefined;
  const shared = globalThis as { [RECORDED]?: Store };
  if (!shared[RECORDED]) {
    const store: Store = new Map();
    shared[RECORDED] = store;
    process.once("exit", () => writeRecorded(store));
  }
  return shared[RECORDED];
}

function remember(name: string, attributes: Attributes): void {
  const store = recordedStore();
  if (!store) return;
  let sets = store.get(name);
  if (!sets) store.set(name, (sets = new Map()));
  sets.set(JSON.stringify(attributes), attributes);
}

/** .tmp/metrics/<the entry script's path>.json, rewritten by each run of that script. */
function writeRecorded(store: Store): void {
  const root = repositoryRoot(process.cwd());
  const entry = process.argv[1];
  if (!root || !entry) return;
  const folder = join(root, ".tmp", "metrics");
  const file = join(folder, `${relative(root, entry).replace(/[^\w.-]+/g, "_")}.json`);
  if (store.size === 0 && !existsSync(file)) return;
  const body = Object.fromEntries([...store].map(([name, sets]) => [name, [...sets.values()]]));
  try {
    mkdirSync(folder, { recursive: true });
    writeFileSync(file, `${JSON.stringify(body, null, 1)}\n`);
  } catch {
    // A read-only checkout records nothing; the check then reports the metrics as not emitted.
  }
}

function repositoryRoot(from: string): string | undefined {
  for (let folder = from; ; folder = dirname(folder)) {
    if (existsSync(join(folder, "pnpm-workspace.yaml"))) return folder;
    if (dirname(folder) === folder) return undefined;
  }
}

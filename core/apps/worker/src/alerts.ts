// The host's alerts to the team channel (README "Alerts"; gamma-p7-040): an activity's final
// failure, a failed workflow run, an outbox pass's dead letters and a module's own alert events.
// raise() is synchronous and bounded, so no activity, workflow or delivery waits on the channel: it
// counts a repeat of a key queued within ALERTS_REPEAT_MINUTES (config.ts, 15 unset) instead of
// queueing it, and drops the oldest alert past ALERT_QUEUE_MAX. A timer loop drains the queue
// outside every activity, workflow and transaction, each send in its own span (the providers
// boundary opens none), at most ALERT_SEND_ATTEMPTS times, then the alert is dropped and logged with
// its code. A send is no activity, so an alert never raises another. The text takes allowed parts only: the environment,
// the kind, a name and a code shaped like words, an event's id fields and numbers, the repeat count.
// Never an error's message, a stack, a URL or another payload field: Slack's <!channel> and Discord's
// @everyone would ping the whole channel. With PROVIDER_ALERTS empty nothing is bound and every
// alert is dropped silently. A worker that crashes loses its queue: the modules' mails stay the
// reliable route.
import { setTimeout as delay } from "node:timers/promises";
import { isAppError, type Logger, platformConfig, subscribe, withSpan } from "@whytide/platform";
import { ALERT_TEXT_MAX, alertsConfig, alertsPort, getAdapter } from "@whytide/providers";
import { workerConfig } from "./config.ts";
import {
  ALERT_DRAIN_MS,
  ALERT_ID,
  ALERT_ID_KEY,
  ALERT_NOT_RETRIED,
  ALERT_NUMBER_KEY,
  ALERT_QUEUE_MAX,
  ALERT_REPEAT_SIGN,
  ALERT_RETRY_AFTER_MAX_SEC,
  ALERT_RETRY_BASE_MS,
  ALERT_SEND_ATTEMPTS,
  ALERT_TOKEN,
  ALERT_UNKNOWN,
} from "./constants.ts";
import { workerMetrics } from "./metrics.ts";

export type AlertKind = "activity" | "workflow" | "outbox" | "event";
export type Alert = {
  readonly kind: AlertKind;
  /** The activity's name, the workflow's type, the event's name, or `dead` for the outbox. */
  readonly name: string;
  /** An activity's error code, or a workflow's failure code or type. */
  readonly code?: string;
  /** An event's payload: its id fields and its numbers alone reach the text. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** The outbox pass's dead letters. */
  readonly count?: number;
};
/** What takes an alert: the host's queue, or a test's recorder. */
export type AlertSink = { raise(alert: Alert): void };
export type AlertQueue = AlertSink & {
  /** Sends the queued alerts, oldest first; a second call while one runs joins it. */
  drain(signal?: AbortSignal): Promise<void>;
  size(): number;
};
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;
export type AlertQueueOptions = {
  /** The alerts port's send, bound at start. */
  readonly send: (input: { text: string }) => Promise<unknown>;
  readonly log: Logger;
  /** The clock of the repeat window, in milliseconds; a test's. */
  readonly now?: () => number;
  /** The wait between a send's attempts; a test's. */
  readonly sleep?: Sleep;
};

type Outcome = "sent" | "repeated" | "dropped" | "failed";
type Queued = { readonly alert: Alert; readonly repeated: number };

const REPEAT_MS = workerConfig.ALERTS_REPEAT_MINUTES * 60_000;
const wait: Sleep = (ms, signal) => delay(ms, undefined, { signal });
const token = (value: string | undefined): string =>
  value !== undefined && ALERT_TOKEN.test(value) ? value : ALERT_UNKNOWN;
const count = (outcome: Outcome) => workerMetrics["worker.alerts"].add(1, { outcome });

/** An event payload's id fields, then its numbers among them, in its order, each `key=value`. */
function payloadParts(payload: Readonly<Record<string, unknown>> = {}) {
  const ids: string[] = [];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === "string" && ALERT_ID_KEY.test(key) && ALERT_ID.test(value)) {
      ids.push(value);
      parts.push(`${key}=${value}`);
    } else if (typeof value === "number" && Number.isFinite(value) && ALERT_NUMBER_KEY.test(key)) {
      parts.push(`${key}=${value}`);
    }
  }
  return { ids, parts };
}

function partsOf(alert: Alert): string[] {
  if (alert.kind === "event") return payloadParts(alert.payload).parts;
  if (alert.kind === "outbox") return [`count=${Math.max(0, Math.trunc(alert.count ?? 0))}`];
  return [];
}

/**
 * The repeat window's key: `activity:<activity>:<code>`, `workflow:<type>:<code or failure type>`,
 * `outbox:dead`, `event:<event name>:<the payload's first id>`.
 */
export function alertKey(alert: Alert): string {
  const name = token(alert.name);
  if (alert.kind === "event") return `event:${name}:${payloadParts(alert.payload).ids[0] ?? ""}`;
  if (alert.kind === "outbox") return `outbox:${name}`;
  return `${alert.kind}:${name}:${token(alert.code)}`;
}

/**
 * `[<APP_ENV>] <kind> <name> <code>`, an event's id fields and numbers or the outbox's count, and
 * `×<n>` for the alerts of its key counted since the last one; at most ALERT_TEXT_MAX characters.
 */
export function alertText(
  alert: Alert,
  repeated = 0,
  appEnv: string = platformConfig.APP_ENV,
): string {
  const head = [`[${token(appEnv)}]`, alert.kind, token(alert.name)];
  if (alert.kind === "activity" || alert.kind === "workflow") head.push(token(alert.code));
  const tail = repeated > 0 ? ` ${ALERT_REPEAT_SIGN}${repeated}` : "";
  let text = head.join(" ");
  for (const part of partsOf(alert)) {
    if (text.length + 1 + part.length + tail.length > ALERT_TEXT_MAX) break;
    text += ` ${part}`;
  }
  return `${text}${tail}`;
}

export function createAlertQueue(options: AlertQueueOptions): AlertQueue {
  const { send, log } = options;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const queue: Queued[] = [];
  /** Per key: when its last alert was queued, and the alerts counted since. */
  const keys = new Map<string, { at: number; repeated: number }>();
  let draining: Promise<void> | undefined;

  function raise(alert: Alert): void {
    try {
      const key = alertKey(alert);
      const at = now();
      // A key past its window with nothing counted is forgotten; a count waits for its key's next alert.
      for (const [other, seen] of keys) {
        if (at - seen.at >= REPEAT_MS && seen.repeated === 0) keys.delete(other);
      }
      const seen = keys.get(key);
      if (seen && at - seen.at < REPEAT_MS) {
        seen.repeated += 1;
        count("repeated");
        return;
      }
      keys.set(key, { at, repeated: 0 });
      queue.push({ alert, repeated: seen?.repeated ?? 0 });
      if (queue.length > ALERT_QUEUE_MAX) {
        queue.shift();
        count("dropped");
      }
    } catch (error) {
      // Never in the way of the activity, the workflow or the delivery that raised it.
      count("dropped");
      log.warn({ err: error, kind: alert.kind }, "worker: an alert could not be queued");
    }
  }

  async function deliver({ alert, repeated }: Queued, signal?: AbortSignal): Promise<void> {
    const text = alertText(alert, repeated);
    let backoff = ALERT_RETRY_BASE_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await withSpan("worker.alert.send", { kind: alert.kind, attempt }, () => send({ text }));
        count("sent");
        return;
      } catch (error) {
        const code = isAppError(error) ? error.code : ALERT_UNKNOWN;
        if (attempt >= ALERT_SEND_ATTEMPTS || ALERT_NOT_RETRIED.has(code) || signal?.aborted) {
          count("failed");
          log.warn({ code, kind: alert.kind, attempt }, "worker: an alert was dropped");
          return;
        }
        const asked = isAppError(error) ? error.details?.retryAfterSec : undefined;
        const seconds = typeof asked === "number" && asked > 0 ? asked : undefined;
        const ms = seconds ? Math.min(seconds, ALERT_RETRY_AFTER_MAX_SEC) * 1000 : backoff;
        backoff *= 2;
        // A stop cuts the wait short; the check above then drops the alert.
        await sleep(ms, signal).catch(() => undefined);
      }
    }
  }

  async function drainAll(signal?: AbortSignal): Promise<void> {
    for (let next = queue.shift(); next; next = queue.shift()) {
      await deliver(next, signal);
      if (signal?.aborted) return;
    }
  }

  return {
    raise,
    drain(signal) {
      draining ??= drainAll(signal).finally(() => {
        draining = undefined;
      });
      return draining;
    },
    size: () => queue.length,
  };
}

let bound: AlertSink | undefined;

/** At the worker's start; the function returned, at its close, puts back the one bound before. */
export function bindAlerts(sink: AlertSink): () => void {
  const previous = bound;
  bound = sink;
  return () => {
    if (bound === sink) bound = previous;
  };
}

/** Puts an alert on the bound queue, at once; with none bound, PROVIDER_ALERTS empty, drops it. */
export function raiseAlert(alert: Alert): void {
  bound?.raise(alert);
}

const subscribed = new Set<string>();

/**
 * Subscribes to each module's alert event, once per process however many hosts start: the handler
 * only queues, so no I/O runs inside the delivery's transaction.
 */
export function subscribeAlerts(events: readonly string[]): void {
  for (const name of events) {
    if (subscribed.has(name)) continue;
    subscribed.add(name);
    subscribe<Readonly<Record<string, unknown>>>(name, (payload) => {
      raiseAlert({ kind: "event", name, payload });
    });
  }
}

export type AlertsStart = {
  readonly log: Logger;
  /** PROVIDER_ALERTS by default; empty for no team channel. */
  readonly selector?: string;
  readonly now?: () => number;
  readonly sleep?: Sleep;
};
export type AlertsHost = { stop(): Promise<void> };

/**
 * Binds the alerts port and the queue, and starts the timer loop that drains it every
 * ALERT_DRAIN_MS. With no adapter selected it logs `worker: team channel off` once and binds nothing.
 */
export async function startAlerts(options: AlertsStart): Promise<AlertsHost> {
  const { log } = options;
  const selector = options.selector ?? alertsConfig.PROVIDER_ALERTS;
  if (!selector) {
    log.info("worker: team channel off");
    return { stop: async () => undefined };
  }
  const alerts = await getAdapter(alertsPort, selector);
  const queue = createAlertQueue({ ...options, send: (input) => alerts.send(input) });
  const unbind = bindAlerts(queue);
  const stopping = new AbortController();
  const { signal } = stopping;
  const loop = (async () => {
    while (!signal.aborted) {
      await queue.drain(signal);
      await wait(ALERT_DRAIN_MS, signal).catch(() => undefined);
    }
  })();
  return {
    async stop() {
      unbind();
      stopping.abort();
      await loop;
    },
  };
}

/**
 * Trel SDK for Node.js
 * Auto-instruments HTTP, captures exceptions, forwards console logs with trace context,
 * and sends everything to ingest.trel.to.
 *
 * Usage:
 *   import { init, captureException } from '@trel-to/sdk';
 *   init({ apiKey: 'trel_sk_xxx', service: 'my-api', environment: 'qa', release: process.env.GIT_SHA });
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SpanStatusCode, trace, type Span } from "@opentelemetry/api";

const DEFAULT_ENDPOINT = "https://ingest.trel.to";

export interface TrelOptions {
  apiKey: string;
  service?: string;
  environment?: string;
  /** Release / version tag (git sha, semver). Sent as `service.version` and `x-trel-release`. */
  release?: string;
  endpoint?: string;
  logs?: {
    /** Forward console.log/info/warn/error/debug as OTLP log records (default true). */
    console?: boolean;
  };
}

export interface TraceContext {
  traceId: string;
  spanId: string;
}

let initialized = false;
let headers: Record<string, string> = {};
let logsUrl = "";
let resourceAttrs: Record<string, string> = {};

/** Active trace/span ids for manual log correlation, or null outside a span. */
export function getTraceContext(): TraceContext | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const ctx = span.spanContext();
  if (!ctx.traceId || /^0+$/.test(ctx.traceId)) return null;
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/* ------------------------------------------------------------ exceptions */

function recordOnSpan(span: Span, err: unknown, context?: Record<string, unknown>): void {
  const error = err instanceof Error ? err : new Error(String(err));
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  if (context) {
    for (const [k, v] of Object.entries(context)) {
      if (v == null) continue;
      span.setAttribute(k, typeof v === "object" ? JSON.stringify(v) : (v as string | number | boolean));
    }
  }
}

/**
 * Records an exception on the active span (or a short `exception` span when none is active).
 * Safe to call anywhere; never throws.
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  try {
    const active = trace.getActiveSpan();
    if (active) {
      recordOnSpan(active, err, context);
      return;
    }
    const span = trace.getTracer("trel").startSpan("exception");
    recordOnSpan(span, err, context);
    span.end();
  } catch {
    // never let telemetry break the app
  }
}

/* ------------------------------------------------------------------ logs */

type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";
const SEVERITY: Record<ConsoleLevel, { number: number; text: string }> = {
  debug: { number: 5, text: "DEBUG" },
  log: { number: 9, text: "INFO" },
  info: { number: 9, text: "INFO" },
  warn: { number: 13, text: "WARN" },
  error: { number: 17, text: "ERROR" },
};

interface LogRecord {
  timeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: Array<{ key: string; value: { stringValue: string } }>;
  traceId?: string;
  spanId?: string;
}

const LOG_BATCH_SIZE = 100;
const LOG_FLUSH_MS = 2000;
let logQueue: LogRecord[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;
let inTrelLog = false;

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  if (typeof arg === "object") {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Error) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

function flushLogs(): void {
  if (logTimer) {
    clearTimeout(logTimer);
    logTimer = null;
  }
  if (logQueue.length === 0 || !logsUrl) return;
  const batch = logQueue;
  logQueue = [];
  const payload = {
    resourceLogs: [
      {
        resource: {
          attributes: Object.entries(resourceAttrs).map(([key, value]) => ({ key, value: { stringValue: value } })),
        },
        scopeLogs: [{ scope: { name: "trel-console" }, logRecords: batch }],
      },
    ],
  };
  try {
    void fetch(logsUrl, { method: "POST", headers, body: JSON.stringify(payload) }).catch(() => undefined);
  } catch {
    // fetch unavailable (very old Node) — drop silently
  }
}

function enqueueLog(level: ConsoleLevel, args: unknown[]): void {
  let attrs: Array<{ key: string; value: { stringValue: string } }> = [];
  let parts = args;
  const last = args[args.length - 1];
  if (args.length > 1 && isPlainObject(last)) {
    parts = args.slice(0, -1);
    attrs = Object.entries(last)
      .filter(([, v]) => v != null)
      .slice(0, 50)
      .map(([k, v]) => ({ key: k, value: { stringValue: formatArg(v) } }));
  }
  const body = parts.map(formatArg).join(" ");
  const sev = SEVERITY[level];
  const record: LogRecord = {
    timeUnixNano: `${Date.now()}000000`,
    severityNumber: sev.number,
    severityText: sev.text,
    body: { stringValue: body.slice(0, 32_000) },
    attributes: attrs,
  };
  const ctx = getTraceContext();
  if (ctx) {
    record.traceId = ctx.traceId;
    record.spanId = ctx.spanId;
  }
  logQueue.push(record);
  if (logQueue.length >= LOG_BATCH_SIZE) flushLogs();
  else if (!logTimer) logTimer = setTimeout(flushLogs, LOG_FLUSH_MS);
}

function patchConsole(): void {
  const levels: ConsoleLevel[] = ["debug", "log", "info", "warn", "error"];
  for (const level of levels) {
    const original = console[level] as (...args: unknown[]) => void;
    if (typeof original !== "function") continue;
    console[level] = (...args: unknown[]) => {
      original.apply(console, args);
      if (inTrelLog) return;
      inTrelLog = true;
      try {
        enqueueLog(level, args);
      } catch {
        // never throw from console
      } finally {
        inTrelLog = false;
      }
    };
  }
}

/* ------------------------------------------------------------------ init */

export function init(options: TrelOptions): void {
  if (initialized) return;

  const {
    apiKey,
    service = "unknown",
    environment,
    release,
    endpoint = DEFAULT_ENDPOINT,
    logs = {},
  } = options;

  headers = {
    "x-trel-key": apiKey,
    "Content-Type": "application/json",
  };
  if (environment) headers["x-trel-environment"] = environment;
  if (release) headers["x-trel-release"] = release;
  logsUrl = `${endpoint}/v1/logs`;

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers,
  });

  resourceAttrs = { [ATTR_SERVICE_NAME]: service };
  if (environment) resourceAttrs["deployment.environment"] = environment;
  if (release) resourceAttrs["service.version"] = release;

  const sdk = new NodeSDK({
    traceExporter,
    resource: new Resource(resourceAttrs),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });

  sdk.start();

  if (logs.console !== false) patchConsole();

  if (typeof process !== "undefined") {
    process.on("uncaughtException", (err) => {
      captureException(err, { "trel.uncaught": true });
      console.error("Trel: Uncaught exception", err);
    });
    process.on("unhandledRejection", (reason, promise) => {
      captureException(reason, { "trel.unhandled_rejection": true });
      console.error("Trel: Unhandled rejection", reason, promise);
    });
    process.on("beforeExit", () => {
      flushLogs();
    });
  }

  initialized = true;
}

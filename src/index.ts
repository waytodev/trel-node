/**
 * Trel SDK for Node.js
 * Auto-instruments HTTP, captures exceptions, sends traces to ingest.trel.to
 *
 * Usage:
 *   import { init } from '@trel-to/sdk';
 *   init({ apiKey: 'trel_sk_xxx', service: 'my-api' });
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const DEFAULT_ENDPOINT = "https://ingest.trel.to";

export interface TrelOptions {
  apiKey: string;
  service?: string;
  endpoint?: string;
}

let initialized = false;

export function init(options: TrelOptions): void {
  if (initialized) return;

  const { apiKey, service = "unknown", endpoint = DEFAULT_ENDPOINT } = options;

  const traceExporter = new OTLPTraceExporter({
    url: `${endpoint}/v1/traces`,
    headers: {
      "x-trel-key": apiKey,
      "Content-Type": "application/json",
    },
  });

  const sdk = new NodeSDK({
    traceExporter,
    resource: new Resource({
      [ATTR_SERVICE_NAME]: service,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-net": { enabled: false },
      }),
    ],
  });

  sdk.start();

  if (typeof process !== "undefined") {
    process.on("uncaughtException", (err) => {
      console.error("Trel: Uncaught exception", err);
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error("Trel: Unhandled rejection", reason, promise);
    });
  }

  initialized = true;
}

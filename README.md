# @trel-to/sdk

Trel SDK for Node.js — OpenTelemetry (OTEL) based observability for [trel.to](https://trel.to). Auto-instruments HTTP, captures traces via OTLP, and sends data to Trel.

## Install

```bash
npm install @trel-to/sdk
```

## Usage

```javascript
import { init } from '@trel-to/sdk';

init({
  apiKey: 'trel_sk_your_api_key',
  service: 'my-api',
});
```

Call `init()` before any other imports. After this, HTTP requests (Express, Fastify, fetch, etc.) are traced and sent to Trel.

**OpenTelemetry support:** Uses the official `@opentelemetry/sdk-node` and OTLP HTTP exporter. Compatible with any OTEL instrumentation. Sends traces to Trel's OTLP endpoint (`https://ingest.trel.to/v1/traces`).

## Options

| Option    | Required | Default              | Description                      |
| --------- | -------- | -------------------- | -------------------------------- |
| `apiKey`  | Yes      | —                    | Your Trel API key                |
| `service` | No       | `'unknown'`          | Service name for your app        |
| `environment` | No   | `'production'`       | Deployment environment (`qa`, `staging`, …) |
| `release` | No       | —                    | Release tag (git sha / semver); enables release health + source maps |
| `logs.console` | No  | `true`               | Forward `console.*` as logs with trace ids attached |
| `endpoint`| No       | `https://ingest.trel.to` | Custom ingestion URL         |

Also exported: `captureException(err, context?)` records an error on the active span, and `getTraceContext()` returns `{ traceId, spanId }` for manual log correlation.

## License

MIT

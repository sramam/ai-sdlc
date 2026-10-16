# Recipe: `telemetry`

One span per capability call, an attribute registry that refuses undeclared
keys, a Workers-native tracer for the binding, and an in-memory exporter for
tests. Verified under workerd: the custom span appeared as a child of
Cloudflare's own request span, with its attributes
([../../spike-2026-10.md](../../spike-2026-10.md)).

| file                    | is                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/attributes.ts`     | `ATTRIBUTES`: every key a span may carry, its type and whether it may hold personal data                             |
| `src/span.ts`           | `inSpan(tracer, name, attrs, fn)`: outcome from the result (`ok`, `refused` + code, `error`); `Tracer`, `noopTracer` |
| `src/memory.ts`         | `memoryTracer()`: records spans, parented by `AsyncLocalStorage`; refuses unknown keys (`TEL-001`)                   |
| `src/workers-tracer.ts` | binding side only: `tracing.enterSpan` from `cloudflare:workers`                                                     |
| `src/span.test.ts`      | outcome, nesting under concurrency, refusal, exceptions                                                              |

## What Cloudflare provides (docs read 2026-10-15)

- **Automatic traces** of the request, outbound `fetch`, and binding calls
  (KV, R2, Durable Objects). Locally, `hyperdrive_connect` appeared as a span;
  individual SQL queries over the socket do not. Enabled by
  `observability.traces.enabled`; automatic tracing is described as early beta.
- **Custom spans** through `tracing` from `cloudflare:workers` (or
  `ctx.tracing`): `enterSpan`, `startActiveSpan`, `startSpan`, `getActiveSpan`,
  `setAttribute(s)`, `recordException`. Not yet: `setStatus` and trace/span IDs
  (so no `traceparent` propagation from user code). Span names truncate at 64 bytes.
  Not `@opentelemetry/api`; the docs do not say it is supported, so the port
  depends on the small `Tracer` interface instead.
- **OTLP export** of traces and logs to any OTLP endpoint (Honeycomb, Grafana,
  Axiom, SigNoz …): create a destination (dashboard), then name it in
  `observability.traces.destinations` / `observability.logs.destinations`.
  JSON OTLP only, not protobuf. Metrics cannot be exported.
- **Locally**, `wrangler dev` stores spans and logs and answers SQL at
  `POST /cdn-cgi/local/explorer/api/local/observability/query`
  (`SELECT name, json(attributes) FROM spans`). An end-to-end test can assert
  on real spans there.

## Rules

- The port calls `inSpan` with a `Tracer` it is given; it never imports
  `cloudflare:workers`.
- `deployment.environment` is not set per span. Which resource attributes
  Cloudflare's export adds (and whether the environment is among them) was not
  checked in the spike; the Worker name differs per environment (`app-staging`).
- Add a key to `ATTRIBUTES` before using it, with `pii` decided. An email, a token, a full URL or a request body never goes on a span; an id may ([observability.md](../../observability.md)).

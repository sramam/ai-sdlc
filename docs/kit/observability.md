# Observability — OpenTelemetry from the first commit

**OTel is a first principle** ([principles.md](principles.md) §16). It is not
added later. A capability with no span is not done, in the same way that a
capability with no test is not done. The first time you need a trace is during
an incident, and an incident is too late to add one.

## What is emitted

| signal      | what                                                                                                                                                                         | from where                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **traces**  | one root span per request, job or queue message; **one child span per capability call**; spans around every external call (DB, model, email, payments, authorization engine) | `@<scope>/telemetry` helpers in the binding and the port             |
| **logs**    | structured and **correlated** (each record carries `trace_id` / `span_id`), only at decisions and failures, never narration                                                  | the same package; `console.log` is refused by lint                   |
| **metrics** | request rate, errors and duration per capability; queue depth and age; job outcomes; model tokens and cost; authorization denials                                            | derived from spans where the backend supports it, explicit otherwise |

## Span conventions

Every capability span carries:

```
capability.name     "invoice.create"
caller.kind         user | system | staff | agent
caller.role         the role in the active tenant (never the user's email)
tenant.id           opaque ID (if the access model has tenants)
outcome             ok | refused | error
refusal.code        FORBIDDEN | CONFLICT | NOT_FOUND | …   (when refused)
error.code          AREA-NNN                              (when error)
```

- **Follow the OTel semantic conventions** for HTTP, DB and messaging. Use your
  own attribute names only where no convention exists, and register them in one
  file.
- **Error codes are attributes.** `AREA-NNN` codes (principles.md §12) make
  "how often does X happen" a query rather than a grep.
- **Refusals are not errors.** A `refused` outcome is the product working. Count
  refusals, but do not alert on them, unless a spike suggests probing.
- **Model calls** record the model, the provider route, input and output tokens,
  cost, and latency. Prompts and completions are recorded **only** in
  environments allowed to hold that data, and redacted.

## Privacy: telemetry is a data store too

Under the highest threat model, the telemetry backend is a third party holding
whatever you send it:

- **Allow-list attributes; never deny-list them.** The telemetry package
  refuses any attribute key that is not registered. Free-form objects are never
  logged.
- **No PII, secrets, tokens, full URLs with query strings, or request bodies.**
  Use IDs, not emails.
- **A pattern check** fails if a span or log call passes an unregistered key.
- Retention in the backend is set to match the data classification, and written
  down.

## On Cloudflare Workers (_verify in the first spike_)

- Workers has built-in observability and can export traces and logs to an OTLP
  endpoint. Check what it captures automatically, and add the capability spans
  through `@<scope>/telemetry`, which must work under that model.
- **Cloudflare exports natively** (OTLP/JSON, configured with
  `observability.*.destinations`), so there is no in-Worker exporter to flush.
  `ctx.waitUntil` matters only for a self-managed exporter.
- **Custom spans** come from `tracing.enterSpan` in `cloudflare:workers`. User
  code cannot read trace or span IDs yet, so propagating trace context by hand
  through Queues or Workflows is not possible today; whether the platform links
  them was not tested (docs/kit/spike-2026-10.md).
- **`wrangler dev` stores spans locally** and answers SQL at
  `/cdn-cgi/local/explorer/api/local/observability/query`, so an end-to-end test
  can assert real spans, not only a test exporter's.
- Local and tests: a console or in-memory exporter. **Tests assert spans**: the
  capability name, the outcome, and that no unregistered attribute appears.

## What uses it

- Handoffs link a trace for anything left broken.
- `/idea` and `/add-requirement` ask, for any feature: **what would we need to see to
  know it works in production?** That answer becomes a span attribute or a
  metric, written as part of the requirement.
- Alerting: error rate per capability, queue age, model spend per day, and
  authorization-denial spikes. Few alerts, each with a written response.

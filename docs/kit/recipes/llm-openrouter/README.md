# Recipe: `llm-openrouter`

`@scope/llm`: the one way the product calls a model, through OpenRouter, with
the data policy enforced per request in code ([security.md](../../security.md)
§ _Model providers_, [ai.md](../../ai.md) § _Building AI features_).

```ts
const llm = createLlm({ config: LLM_CONFIG, transport: openRouterTransport({ apiKey }), ledger });
const r = await llm.generate({
  role: "classify",
  dataClass: "tenant",
  tenantId,
  runId,
  messages,
  schema: Category,
  schemaName: "category",
});
// { ok: true, value, usage } | { ok: false, code: "NO_ROUTE" | "OVER_BUDGET" | "UNAVAILABLE" | "BAD_OUTPUT", detail }
```

| file                        | is                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `src/config.ts`             | data classes, model per role, the reviewed ZDR allow-list (with its date), prices, caps                            |
| `src/routing.ts`            | `routeFor(config, dataClass, model)`: the `provider` object, or a refusal                                          |
| `src/budget.ts`             | `CostLedger` (per run, per tenant per UTC day, integer micro-dollars); `memoryLedger()` for tests                  |
| `src/llm.ts`                | `createLlm(...).generate(req)`: route, cap, call, validate                                                         |
| `src/transport.ts`          | `openRouterTransport` (`fetch`, runtime-free)                                                                      |
| `src/recorded.ts`           | `recordedTransport(cassette)` for tests; `recordingTransport` for the recording run                                |
| `src/allowlist.ts`          | `checkAllowList(zdrEndpoints, config)`; `check-allowlist.mts` runs it against the live list (`pnpm llm:allowlist`) |
| `src/llm.test.ts`           | 14 tests; `fetch` is replaced by a function that fails the test                                                    |
| `src/record.manual.test.ts` | `pnpm llm:record`: re-records the synthetic examples, by hand, with a key                                          |
| `fixtures/`                 | the cassette, and an excerpt of the public ZDR endpoint list read 2026-10-16                                       |

## The route, by data class

| data class  | means                                        | `provider` sent                                                          |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `synthetic` | generated, public or anonymized (dev, evals) | `data_collection: "deny"`, `require_parameters: true`, `max_price`       |
| `personal`  | about a real person                          | the above plus `zdr: true`, and `only: [...]` when `zdrProviders` is set |
| `tenant`    | a customer's business data                   | the same as `personal`                                                   |
| missing     |                                              | **refused** (`LLM-001`), whatever the type system said                   |

A `personal` or `tenant` request on a model not on `zdrModels` is refused
(`LLM-002`) before any call. Every request sends exactly one `model` and never a
`models` list: automatic fallback to another model is off ([ai.md](../../ai.md)).
Provider-level fallback within the route stays on, since every candidate already
satisfies the policy.

`max_price` is the config's price (the highest ZDR endpoint price on the
day it was reviewed), so the pre-flight estimate is an upper bound: no endpoint
that would cost more can be chosen.

## Cost caps, in process

Before the call: the estimate (prompt characters / 3 × prompt price +
`maxTokens` × completion price) plus what the run and the tenant's UTC day have
spent must stay under `caps.perRunUsd` and `caps.perTenantPerDayUsd`
(`LLM-005`, `LLM-006`). After it: `usage.cost` is recorded, or the estimate
marked `estimated: true` when the response carried none, so a guess is never
silently counted as a fact. A call whose answer then fails its schema is still
charged, because it was spent.

`memoryLedger` is per isolate. A deployed Worker needs a shared ledger: a
Durable Object per tenant, or a table of calls summed per day.

## Output is untrusted input

`response_format: { type: "json_schema", json_schema: { name, strict: true,
schema } }` from the Zod schema (`z.toJSONSchema`, without the `$schema` line),
with `require_parameters: true` so only endpoints that honour it are chosen. The
answer is parsed and validated; anything else is `BAD_OUTPUT`. A non-2xx is
`UNAVAILABLE`, and is never retried on a looser route.

## Run the tests

```bash
pnpm test                 # 14 pass, 1 skipped (the manual recording)
pnpm llm:allowlist        # manual, reaches the network: is the allow-list still ZDR?
```

Verified 2026-10-16 (zod 4.6.7, vitest 3.2.4). Proved by tripping: removing
`zdr: true` from the personal/tenant route fails three tests.
`pnpm llm:allowlist` was run live the same day: both allow-listed models
reported `ok` (Gemini 3.5 Flash Lite via Google; Claude Sonnet 5.5 via Amazon
Bedrock and Google).

**The cassette is not a live recording.** No OpenRouter key was available, so
`fixtures/cassette.json` was written from the documented response shape (its
`_source` says so); the second entry is deliberately off-schema. Run
`OPENROUTER_API_KEY=… pnpm llm:record` to replace the synthetic entry with a
real answer. No live request was sent, so OpenRouter's behaviour when no
endpoint satisfies `zdr` + `require_parameters` + `max_price` (the docs name a
404 for a related case) is untested.

## What OpenRouter provides (docs read 2026-10-16)

- **Provider routing** fields: `order`, `allow_fallbacks` (default `true`),
  `require_parameters` (default `false`), `data_collection` (`"allow"` default,
  or `"deny"`: "restricts routing to providers that do not collect user data"),
  `zdr` (`true` routes only to Zero Data Retention endpoints), `only`, `ignore`,
  `quantizations`, `sort`, `max_price` (USD per million tokens, from the docs'
  `$1/m` example) ([Provider routing](https://openrouter.ai/docs/features/provider-routing)).
- **ZDR**: a per-request `zdr: true` can only add enforcement, never relax an
  account or guardrail setting; account-wide ZDR is set per model group in
  privacy settings; ZDR "only applies to provider routing for inference
  requests", not to plugins or tools; in-memory prompt caching is not counted as
  retention; the endpoint list is `GET https://openrouter.ai/api/v1/endpoints/zdr`
  ([Zero Data Retention](https://openrouter.ai/docs/features/zdr)). Observed:
  that list needs no key, held 1,011 endpoints over 368 models on 2026-10-16,
  and lists Anthropic models' ZDR endpoints only through Google and Amazon
  Bedrock, with prices that differ between endpoints of the same model.
- **Structured outputs**: `response_format` as above; support is per endpoint,
  so set `require_parameters: true`; an unsupported model fails with an error
  ([Structured outputs](https://openrouter.ai/docs/features/structured-outputs)).
- **Usage accounting**: every response carries `usage` with `cost` "in
  credits"; `usage: { include: true }` is deprecated and has no effect
  ([Usage accounting](https://openrouter.ai/docs/use-cases/usage-accounting)).
  The recipe treats a credit as a US dollar for its caps; check that against
  the account before relying on the cap's exactness.

## Rules

- **Roles, not models, at call sites.** Changing a model is one line in the
  config, reviewed with its price and its place on the allow-list.
- **The allow-list carries its review date** and is re-checked with
  `pnpm llm:allowlist`; a model that lost its ZDR endpoint, or got dearer than
  the config's `max_price`, is reported.
- **Account settings first, then this** (security.md): prompt logging off and
  training providers excluded at the account, and the per-request policy here
  regardless.
- **A recording holds synthetic data only**; it is committed.
- **Tests never call a model.** A changed prompt is a missing recording
  (`LLM-REC-001`), not a network call.

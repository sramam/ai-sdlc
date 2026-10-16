# Recipe: `env-schema`

One Zod schema for a Worker's **variables and bindings**, parsed once per
isolate, failing with `ENV-001` and the name of everything wrong.

- `src/env.ts`: `envSchema`, `parseEnv(raw)`, `APP_ENVS`. Runtime-free: the app's
  `src/server/env.ts` passes `env` from `cloudflare:workers`.
- `src/env.test.ts`: proves each refusal by tripping it.

Rules it encodes, from [environments.md](../../environments.md):

- **An allow-list of environments.** `APP_ENV` outside `local | dev | staging |
production` is refused, never defaulted.
- **Capture transports are named where they apply** (`local`), so a deployed
  environment declaring `EMAIL_TRANSPORT=capture` does not start.
- **Bindings are checked structurally** (a Hyperdrive binding is an object with
  a `connectionString`), so the schema runs in Node.

Keep `.dev.vars.example` (secrets) and the `vars` in `wrangler.jsonc` in step
with the schema; a census over the three is the next step. Under
`nodejs_compat` with a compatibility date on or after 2025-04-01, vars and
secrets also appear in `process.env`; read them through this schema anyway.

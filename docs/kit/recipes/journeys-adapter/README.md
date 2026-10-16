# Recipe: `journeys-adapter`

A `StackAdapter` ([tooling/journeys/src/stack/host.mts](../../../../tooling/journeys/src/stack/host.mts))
for [`app-tanstack-workers`](../app-tanstack-workers/). Instantiate as
`e2e/stack.mts` and name it in `journeys.config.mts` (`adapter: "e2e/stack.mts"`).
Set `APP_DIR`, `DB` and `BINDING` at the top.

| step        | does                                                                                                                                                                                                                          |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build`     | `vite build`: the built Worker is recorded, never `vite dev`                                                                                                                                                                  |
| `start`     | `db:local start`; `wrangler dev --config dist/server/wrangler.json` on the host's app port, with `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_<BINDING>` = the localdb URL plus a password; `BETTER_AUTH_URL` = the app URL |
| `reset`     | `db:local reset --force`: snapshot, empty, migrate. The localdb port is derived per checkout, so wrangler's URL stays valid                                                                                                   |
| `readyPath` | `/health`                                                                                                                                                                                                                     |
| mail        | the Worker prints `EMAIL-CAPTURE {json}`; the adapter reads wrangler's output and calls `appendCaptured` into `StackEnv.outboxDir`                                                                                            |

Verified through the real `startHost`: build, start, ready, SSR page, a read
through Hyperdrive, an OTP captured to the outbox, sign-in with it, the session,
`POST /reset` emptying the database (the session is gone afterwards), and
teardown.

- **The host's `dbPort` is not used.** localdb picks its own port per
  checkout (55000–55499); the host only needs `dbPort + 1` for its control channel.
- **The database outlives the run.** `stop` releases nothing; `db:local stop`
  is the developer's.
- `stack.test.ts` covers the two pure parts: the password, and reading a
  capture line through wrangler's ANSI decoration.
- `journeys.pattern-check.test.ts` is the project's journey pattern check
  (every screenshot named by its narrative, every evidence folder under a
  registered journey and a declared persona, one spec per walk, every spec
  resetting the stack first), run by `pnpm test` from `e2e/`.

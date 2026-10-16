@ai-sdlc/localdb: `pnpm db:local` — a PGlite database per checkout under `.localdb/<db>/`, on a port derived from the checkout path, with `dumpDataDir` snapshots. See README.md.

- **Many connections share one Postgres session, serialised per exchange**
  (`src/socket.mts`). Interleaving per _message_ broke the unnamed portal
  (`portal "" does not exist`, 9 of 30 in docs/kit/spike-2026-10-evidence.md; it also
  shows up as `invalid input syntax for type bigint`). A connection holds the
  backend from its first message to the ReadyForQuery after `Sync`/`Query`, and
  through an open transaction — so **a long or idle transaction blocks everyone
  else**. Named prepared statements and `SET` are still shared.
- **PGlite sends an extra ReadyForQuery after an extended-protocol error**; the
  server drops it, or a client's replies shift by one ("unexpected
  commandComplete"). Do not "simplify" the frame filter away.
- **Startup is answered from a greeting captured once**, not sent through the
  backend, so a client can connect while another holds a transaction.
- `src/concurrency.test.ts` sends Parse/Bind/Execute/Sync as **separate writes**:
  `pg` writes them in one chunk, which hid the fault from a pg-only test.
- **A lock naming a dead pid is stale**, cleared and said. A `busy` or
  `starting` lock, or an unreadable one, is could-not-ask; nobody guesses.
  Never delete `server.json` while `status` says running.
- **Restore and reset refuse a running database without `--force`.** `migrate`
  refuses to run if its snapshot failed: no migration without a way back.
- **Never `pkill -f server.mts`** — it reaches every worktree's databases. Use
  `pnpm db:local stop`, which signals the pid in this checkout's lock only after
  checking that pid is still our server.
- **`.localdb/` is per checkout and gitignored.** A worktree starts empty: run
  `start`, then `migrate` (or restore a snapshot copied from elsewhere).
- **Snapshots are PGlite-version specific.** A tarball written by one PGlite
  major may not load in another; after bumping `@electric-sql/pglite`, `reset`
  rather than `restore` an old snapshot.
- Not CI: the server is a detached background process that outlives the
  command. Tests start real servers in a temp dir and stop them in `afterAll`.
